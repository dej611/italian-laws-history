import {
  chromeAvailability,
  getLanguageModel,
  nativePromptModelLabel,
  nativePromptOptions,
  nativePromptSupportsImage,
  trySummarizerFromGesture,
  type DownloadProgressEvent,
  type PromptImage,
  type PromptPart,
  type PromptSession,
  type SummarizerLike,
} from "./chrome-prompt";
import { getLocale, t } from "../i18n";
import {
  systemPrompt,
  WLLAMA_MODELS,
  type WllamaModelId,
} from "./prompts";
import type { DigestoChart } from "./chart";
import {
  isTextSearchQuery,
  parseJsonSpec,
  parseQuery,
  QUERY_JSON_SCHEMA,
  slotFillSystemPrompt,
  stripInstructionLeak,
  type QuerySpec,
} from "./query";
import {
  directorSystemPrompt,
  parseDirectorCue,
  type DirectorCue,
  type StepFacts,
  DIRECTOR_JSON_SCHEMA,
} from "./director";
import {
  ACT_BLURB_SCHEMA,
  actBlurbSystem,
  actBlurbUser,
  parseActBlurb,
  type ActBlurb,
} from "./act-blurb";
import {
  clusterEpithetSystem,
  parseEpithet,
  type ClusterFacts,
} from "./clusters";
import {
  GAZZETTA_RUBRICA_SCHEMA,
  gazzettaRubricaSystem,
  gazzettaRubricaUser,
  parseGazzettaRubrica,
  type FeaturedAct,
  type YearFacts,
} from "./gazzetta";
import {
  looksLikeLegalAdvice,
  toolAnalytics,
  toolSearchLaws,
  toolSqlQuery,
  type ToolResult,
} from "./tools";
import { DIGESTO_READY_EVENT } from "./ready-event";

export { DIGESTO_READY_EVENT };
export type { WllamaModelId };
export { WLLAMA_MODELS, WLLAMA_MODEL_IDS } from "./prompts";

export type DigestoStatus =
  | { kind: "unsupported"; reason: string }
  | { kind: "loading"; progress: string }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/** Minimal surface so @wllama/wllama stays out of the first paint chunk. */
type WllamaLike = {
  setCompat: (
    compat:
      | null
      | "default"
      | { wasm: string; worker: string | { code: string } },
    mode?: "safari" | "firefox_safari",
  ) => void;
  isSupportWebGPU: () => boolean;
  loadModelFromHF: (
    model: { repo: string; file: string },
    opts: {
      n_gpu_layers: number;
      progressCallback: (p: { loaded: number; total?: number }) => void;
    },
  ) => Promise<void>;
  createChatCompletion: (opts: {
    messages: Array<{ role: string; content: string }>;
    temperature: number;
    max_tokens: number;
    response_format?: {
      type: "text" | "json_object" | "json_schema";
      json_schema?: { name: string; schema: unknown; strict?: boolean };
    };
  }) => Promise<{ choices: Array<{ message?: { content?: string } }> }>;
  exit: () => Promise<void>;
};

type Backend =
  | { kind: "native"; session: PromptSession; label: string }
  | { kind: "wllama"; wllama: WllamaLike; label: string };

let lastSpec: QuerySpec | null = null;
let backend: Backend | null = null;
let summarizer: SummarizerLike | null = null;
let chromeStatus: Awaited<ReturnType<typeof chromeAvailability>> = "missing";
let loadInFlight: Promise<{ ok: true; model: string } | { ok: false; reason: string }> | null =
  null;

function notifyReady() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DIGESTO_READY_EVENT));
}

export type ModelChoice = "native" | WllamaModelId;

export function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}

export function activeBackendLabel(): string | null {
  return backend?.label ?? null;
}

export function usingChrome(): boolean {
  return backend?.kind === "native";
}

export function nativeSupportsImage(): boolean {
  return backend?.kind === "native" && nativePromptSupportsImage();
}

export function isBackendReady(): boolean {
  return backend != null;
}

export function isSummarizerReady(): boolean {
  return summarizer != null;
}

/** Kick Summarizer.create() in the same user-gesture turn as native Prompt. */
export function startSummarizerFromGesture(): Promise<boolean> {
  const p = trySummarizerFromGesture();
  void p.then((s) => {
    if (s) summarizer = s;
  });
  return p.then((s) => s != null);
}

/** Probe only — never downloads. Call once after mount. */
export async function probeLocalModels(): Promise<{
  chrome: typeof chromeStatus;
  canTryChrome: boolean;
  canTryWllama: boolean;
}> {
  chromeStatus = await chromeAvailability();
  const canTryChrome =
    chromeStatus === "available" ||
    chromeStatus === "downloadable" ||
    chromeStatus === "downloading";
  // wllama needs WASM; WebGPU optional but preferred.
  const canTryWllama = typeof WebAssembly !== "undefined";
  console.info("[Digesto] probe", {
    availability: chromeStatus,
    model: nativePromptModelLabel(),
    canTryNative: canTryChrome,
    canTryWllama,
  });
  return { chrome: chromeStatus, canTryChrome, canTryWllama };
}

export function anyModelPossible(probe: {
  canTryChrome: boolean;
  canTryWllama: boolean;
}): boolean {
  return probe.canTryChrome || probe.canTryWllama;
}

function progressPct(loaded: number, total?: number): number {
  if (total && total > 0) return Math.min(100, Math.round((loaded / total) * 100));
  if (loaded >= 0 && loaded <= 1) return Math.min(100, Math.round(loaded * 100));
  return Math.min(100, Math.round(loaded));
}

function reportLocalProgress(onProgress: (s: string) => void, pct: number) {
  onProgress(t("digesto.progressLocalPct", { pct }));
}

function reportNativeProgress(
  onProgress: (s: string) => void,
  model: string,
  pct: number,
) {
  onProgress(t("digesto.loadingNativePct", { model, pct }));
}

function downloadProgressPct(e: DownloadProgressEvent): number {
  // Edge: loaded/total in bytes. Chrome: often loaded as a 0–1 fraction.
  if (e.total != null && e.total > 0) return progressPct(e.loaded, e.total);
  if (e.loaded >= 0 && e.loaded <= 1) return progressPct(e.loaded);
  return progressPct(e.loaded, e.total);
}

/**
 * Start LanguageModel.create() in the same turn as the user gesture (no await before this).
 * Chrome: Gemini Nano (+ language attestation). Edge: Phi-4-mini (bare create per MS docs).
 * No timeout — native download can take a long time; progress via monitor.
 */
function tryNativePromptFromGesture(
  onProgress: (s: string) => void,
): Promise<Backend | null> {
  const LanguageModel = getLanguageModel();
  if (!LanguageModel) return Promise.resolve(null);
  if (
    chromeStatus !== "available" &&
    chromeStatus !== "downloadable" &&
    chromeStatus !== "downloading"
  ) {
    return Promise.resolve(null);
  }

  const needsDownload = chromeStatus !== "available";
  const label = nativePromptModelLabel();
  if (needsDownload) {
    onProgress(t("digesto.loadingNative", { model: label }));
  } else {
    reportNativeProgress(onProgress, label, 1);
  }

  console.info("[Digesto] Prompt API create", {
    availability: chromeStatus,
    model: label,
    userActivation: (navigator as Navigator & { userActivation?: { isActive: boolean } })
      .userActivation?.isActive,
  });

  return LanguageModel.create({
    ...nativePromptOptions(),
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => {
        const pct = downloadProgressPct(e);
        const done =
          (e.total != null && e.total > 0 && e.loaded >= e.total) || e.loaded >= 1;
        reportNativeProgress(onProgress, label, done ? 99 : pct);
      });
    },
  })
    .then((session) => {
      reportNativeProgress(onProgress, label, 100);
      chromeStatus = "available";
      return { kind: "native" as const, session, label };
    })
    .catch((e) => {
      console.warn("[Digesto] native Prompt API create failed", e);
      return null;
    });
}

async function tryInitWllama(
  modelId: WllamaModelId,
  onProgress: (s: string) => void,
): Promise<Backend | null> {
  const model = WLLAMA_MODELS[modelId];
  if (!model) return null;

  // Main wasm + Safari/compat assets (Memory64/JSPI missing on Safari).
  const [{ Wllama, LoggerWithoutDebug }, wasmMod, compatWasmMod, compatWorkerMod] =
    await Promise.all([
      import("@wllama/wllama/esm/index.js"),
      import("@wllama/wllama/esm/wasm/wllama.wasm?url"),
      import("@wllama/wllama-compat/wasm/wllama.wasm?url"),
      import("@wllama/wllama-compat/wasm/wllama.js?raw"),
    ]);
  const wasmUrl = wasmMod.default as string;
  const compatWasmUrl = compatWasmMod.default as string;
  const compatWorkerCode = compatWorkerMod.default as string;

  const wllama = new Wllama(
    { default: wasmUrl },
    { logger: LoggerWithoutDebug, allowOffline: true },
  ) as WllamaLike;
  // Self-host compat (constructor defaults to CDN); required for Safari.
  wllama.setCompat({
    wasm: compatWasmUrl,
    worker: { code: compatWorkerCode },
  });
  try {
    reportLocalProgress(onProgress, 0);
    await wllama.loadModelFromHF(
      { repo: model.repo, file: model.file },
      {
        // Use wllama's check (WebGPU + JSPI), not bare navigator.gpu.
        n_gpu_layers: wllama.isSupportWebGPU() ? 99 : 0,
        progressCallback: ({ loaded, total }) => {
          reportLocalProgress(onProgress, progressPct(loaded, total));
        },
      },
    );
    reportLocalProgress(onProgress, 100);
    return { kind: "wllama", wllama, label: `wllama · ${model.label}` };
  } catch (e) {
    console.warn("[Digesto] wllama model failed", model.label, e);
    try {
      await wllama.exit();
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Load a chosen backend.
 * For `native`, call from a user-gesture handler (pointerdown/click) so create()
 * can start the browser model download — no timeout; progress via onProgress.
 */
export function loadModel(
  choice: ModelChoice,
  onProgress: (s: string) => void,
): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
  if (backend) return Promise.resolve({ ok: true, model: backend.label });
  if (loadInFlight) return loadInFlight;

  if (choice === "native") {
    // Kick create() in this same turn (before any await).
    const nativePromise = tryNativePromptFromGesture(onProgress);
    loadInFlight = (async () => {
      try {
        const native = await nativePromise;
        if (native) {
          lastSpec = null;
          backend = native;
          notifyReady();
          return { ok: true as const, model: native.label };
        }
        return { ok: false as const, reason: t("digesto.noModel") };
      } finally {
        loadInFlight = null;
      }
    })();
    return loadInFlight;
  }

  const modelId = choice;
  loadInFlight = (async () => {
    try {
      onProgress(t("digesto.progressLocal"));
      const wl = await tryInitWllama(modelId, onProgress);
      if (wl) {
        lastSpec = null;
        backend = wl;
        notifyReady();
        return { ok: true as const, model: wl.label };
      }
      return { ok: false as const, reason: t("digesto.noModel") };
    } finally {
      loadInFlight = null;
    }
  })();
  return loadInFlight;
}

/** @deprecated use loadModel — kept for callers */
export function loadModelFromUserGesture(
  onProgress: (s: string) => void,
): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
  return loadModel("qwen", onProgress);
}

/** @deprecated use loadModel */
export async function initDigesto(
  onProgress: (s: string) => void,
): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
  return loadModel("qwen", onProgress);
}

function formatToolBlock(citations: ToolResult[]): string {
  if (!citations.length) return "(nessun fatto)";
  return citations
    .map((c) => {
      const fact = c.risposta ? `Fatto: ${c.risposta}\n` : "";
      return `[${c.name}${c.ok ? "" : " ERRORE"}]\n${fact}${c.content.slice(0, 800)}`;
    })
    .join("\n\n");
}

function userPrompt(userText: string, citations: ToolResult[]): string {
  const lang = getLocale() === "en" ? "English" : "italiano";
  const ask =
    getLocale() === "en" ? `User question: ${userText}` : `Domanda dell'utente: ${userText}`;
  const facts =
    getLocale() === "en" ? "FACTS (use these):" : "FATTI (usa questi):";
  const write =
    getLocale() === "en"
      ? `Write only the final answer in ${lang}.`
      : `Scrivi solo la risposta finale in ${lang}.`;
  return `${ask}

${facts}
${formatToolBlock(citations)}

${write}`;
}

function sanitizeModelAnswer(text: string): string {
  const cleaned = stripInstructionLeak(text);
  return cleaned || t("digesto.unclearAnswer");
}

async function completeWith(
  system: string,
  prompt: string,
  opts?: {
    jsonSchema?: boolean;
    schema?: unknown;
    schemaName?: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    image?: PromptImage | null;
  },
): Promise<string> {
  if (!backend) throw new Error(t("digesto.engineNotReady"));

  if (backend.kind === "native") {
    const schema = opts?.jsonSchema ? (opts.schema ?? QUERY_JSON_SCHEMA) : undefined;
    const text = `${system}\n\n${prompt}`;
    const input: string | PromptPart[] =
      opts?.image && nativePromptSupportsImage()
        ? [text, { type: "image", value: opts.image }]
        : text;
    const reply = schema
      ? await backend.session.prompt(input, {
          responseConstraint: schema,
          signal: opts?.signal,
        })
      : await backend.session.prompt(input, { signal: opts?.signal });
    return reply?.trim() || "";
  }

  const reply = await backend.wllama.createChatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    temperature: opts?.temperature ?? 0.1,
    max_tokens: opts?.maxTokens ?? 220,
    ...(opts?.jsonSchema
      ? {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: opts.schemaName ?? "QuerySpec",
              schema: opts.schema ?? QUERY_JSON_SCHEMA,
              strict: true,
            },
          },
        }
      : {}),
  });
  return reply.choices[0]?.message?.content?.trim() || "";
}

async function complete(prompt: string): Promise<string> {
  return sanitizeModelAnswer(await completeWith(systemPrompt(), prompt));
}

async function slotFillFromModel(userText: string): Promise<QuerySpec | null> {
  const locale = getLocale();
  try {
    const raw = await completeWith(slotFillSystemPrompt(locale), userText, {
      jsonSchema: true,
      schema: QUERY_JSON_SCHEMA,
      schemaName: "QuerySpec",
      maxTokens: 120,
      temperature: 0,
    });
    return parseJsonSpec(raw);
  } catch {
    return null;
  }
}

export function resetDigestoQueryState() {
  lastSpec = null;
}

export async function directorCueFromModel(
  _stepId: string,
  facts: StepFacts,
  locale: ReturnType<typeof getLocale>,
  signal?: AbortSignal,
  image?: PromptImage | null,
): Promise<DirectorCue | null> {
  if (!backend) return null;
  const useImage = Boolean(image && backend.kind === "native" && nativePromptSupportsImage());
  const factsBlock =
    locale === "en"
      ? `FACTS:\n${JSON.stringify(facts)}\nWrite JSON only.`
      : `FATTI:\n${JSON.stringify(facts)}\nScrivi solo JSON.`;
  try {
    const raw = await completeWith(directorSystemPrompt(locale, useImage), factsBlock, {
      jsonSchema: true,
      schema: DIRECTOR_JSON_SCHEMA,
      schemaName: "DirectorCue",
      maxTokens: 120,
      temperature: 0.2,
      signal,
      image: useImage ? image : null,
    });
    if (signal?.aborted) return null;
    return parseDirectorCue(raw, facts, locale);
  } catch {
    return null;
  }
}

const actBlurbCache = new Map<string, ActBlurb>();

export async function summarizeAct(
  title: string,
  excerpt: string,
  arc: string,
  locale: ReturnType<typeof getLocale>,
  signal?: AbortSignal,
): Promise<ActBlurb | null> {
  const key = `${locale}:${title}:${excerpt.slice(0, 80)}:${arc}`;
  const hit = actBlurbCache.get(key);
  if (hit) return hit;
  if (!backend) return null;
  try {
    const raw = await completeWith(
      actBlurbSystem(locale),
      actBlurbUser({ title, excerpt, arc, locale }),
      {
        jsonSchema: true,
        schema: ACT_BLURB_SCHEMA,
        schemaName: "ActBlurb",
        maxTokens: 280,
        temperature: 0.2,
        signal,
      },
    );
    if (signal?.aborted) return null;
    const parsed = parseActBlurb(raw, locale);
    if (!parsed) return null;
    actBlurbCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

const gazzettaCache = new Map<string, string>();

export async function gazzettaRubricaFromModel(
  facts: YearFacts,
  featured: FeaturedAct | null,
  locale: ReturnType<typeof getLocale>,
  signal?: AbortSignal,
): Promise<string | null> {
  const key = `${locale}:${facts.year}:${featured?.slug ?? ""}`;
  const hit = gazzettaCache.get(key);
  if (hit) return hit;
  if (!backend) return null;
  try {
    const raw = await completeWith(
      gazzettaRubricaSystem(locale),
      gazzettaRubricaUser({ facts, featured, locale }),
      {
        jsonSchema: true,
        schema: GAZZETTA_RUBRICA_SCHEMA,
        schemaName: "GazzettaRubrica",
        maxTokens: 220,
        temperature: 0.2,
        signal,
      },
    );
    if (signal?.aborted) return null;
    const parsed = parseGazzettaRubrica(raw, facts, featured, locale);
    if (!parsed) return null;
    gazzettaCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export async function clusterEpithetFromModel(
  facts: ClusterFacts,
  locale: ReturnType<typeof getLocale>,
): Promise<string | null> {
  if (!backend) return null;
  const prompt =
    locale === "en"
      ? `Hub label: ${facts.hubLabel}. Size: ${facts.size}. Years: ${facts.fromYear ?? "?"}–${facts.toYear ?? "?"}.`
      : `Hub: ${facts.hubLabel}. Dimensione: ${facts.size}. Anni: ${facts.fromYear ?? "?"}–${facts.toYear ?? "?"}.`;
  try {
    const raw = await completeWith(clusterEpithetSystem(locale), prompt, {
      jsonSchema: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["epithet"],
        properties: { epithet: { type: "string" } },
      },
      schemaName: "Epithet",
      maxTokens: 40,
      temperature: 0.2,
    });
    const epi = parseEpithet(raw);
    if (!epi) return null;
    const hubBit = facts.hubLabel.slice(0, 12);
    if (hubBit && !epi.toLowerCase().includes(hubBit.toLowerCase().slice(0, 6))) {
      // Still allow generic "nodo del 1925" if year matches
      const y = String(facts.fromYear ?? facts.toYear ?? "");
      if (!y || !epi.includes(y)) return null;
    }
    return epi;
  } catch {
    return null;
  }
}

export async function askDigesto(userText: string): Promise<{
  answer: string;
  citations: ToolResult[];
  chart?: DigestoChart;
}> {
  if (looksLikeLegalAdvice(userText)) {
    return {
      answer: t("digesto.refuseAdvice"),
      citations: [],
    };
  }
  if (!backend) throw new Error(t("digesto.engineNotReady"));

  const trimmed = userText.trim();
  if (/^(select|with)\b/i.test(trimmed)) {
    const citation = await toolSqlQuery(trimmed);
    const answer = citation.ok
      ? citation.content.slice(0, 800)
      : citation.content;
    return { answer, citations: [citation] };
  }

  let spec = parseQuery(userText, lastSpec);

  if (!spec && isTextSearchQuery(userText)) {
    const citations = [await toolSearchLaws(userText)];
    const direct = citations.find((c) => c.ok && c.risposta)?.risposta;
    if (direct) return { answer: direct, citations };
    const answer = await complete(userPrompt(userText, citations));
    return { answer, citations };
  }

  if (!spec) spec = await slotFillFromModel(userText);

  if (!spec) {
    return {
      answer: t("digesto.cannedUnknown"),
      citations: [],
    };
  }

  const citation = await toolAnalytics(spec);
  lastSpec = spec;
  return {
    answer: citation.risposta ?? t("digesto.unclearAnswer"),
    citations: [citation],
    chart: citation.chart,
  };
}
