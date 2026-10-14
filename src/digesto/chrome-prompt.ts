/** Minimal typings for the browser Prompt API (LanguageModel). */
export type PromptAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export type DownloadProgressEvent = {
  loaded: number;
  /** Edge reports bytes; Chrome often uses a 0–1 fraction and may omit total. */
  total?: number;
};

export type PromptSessionOptions = {
  initialPrompts?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  expectedInputs?: Array<{ type: "text" | "image" | "audio"; languages?: string[] }>;
  expectedOutputs?: Array<{ type: "text"; languages?: string[] }>;
  signal?: AbortSignal;
  monitor?: (m: {
    addEventListener: (
      type: "downloadprogress",
      listener: (e: DownloadProgressEvent) => void,
    ) => void;
  }) => void;
};

export type PromptImage = ImageBitmap | Blob | HTMLCanvasElement | HTMLImageElement;

export type PromptPart =
  | string
  | { type: "text"; value: string }
  | { type: "image"; value: PromptImage };

export type PromptSession = {
  prompt: (
    input: string | PromptPart[],
    opts?: { responseConstraint?: unknown; signal?: AbortSignal },
  ) => Promise<string>;
  destroy: () => void;
};

export type LanguageModelAPI = {
  availability: (options?: PromptSessionOptions) => Promise<PromptAvailability>;
  create: (options?: PromptSessionOptions) => Promise<PromptSession>;
};

/**
 * Chrome requires attested I/O languages for safety (de/en/es/fr/ja only).
 * Italian isn't supported yet — use en for capability attestation.
 * Edge docs use bare availability()/create() — do not pass these on Edge.
 */
export const CHROME_PROMPT_OPTS = {
  expectedInputs: [{ type: "text" as const, languages: ["en"] }],
  expectedOutputs: [{ type: "text" as const, languages: ["en"] }],
};

export const CHROME_PROMPT_OPTS_VISION = {
  expectedInputs: [
    { type: "text" as const, languages: ["en"] },
    { type: "image" as const },
  ],
  expectedOutputs: [{ type: "text" as const, languages: ["en"] }],
};

/** @deprecated use CHROME_PROMPT_OPTS */
export const NATIVE_PROMPT_OPTS = CHROME_PROMPT_OPTS;

let cachedNativeOpts: PromptSessionOptions | null = null;
let nativeImageOk = false;

export function isEdgeBrowser(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Edg\//.test(ua);
}

/** Session options that must match between availability() and create(). */
export function nativePromptOptions(): PromptSessionOptions {
  if (cachedNativeOpts) return cachedNativeOpts;
  // Edge Phi-4-mini: bare create (Microsoft docs). Chrome Gemini Nano: language attestation.
  return isEdgeBrowser() ? {} : { ...CHROME_PROMPT_OPTS };
}

/** True after a successful availability/create with image inputs. */
export function nativePromptSupportsImage(): boolean {
  return nativeImageOk;
}

function usable(status: PromptAvailability): boolean {
  return status === "available" || status === "downloadable" || status === "downloading";
}

export function getLanguageModel(): LanguageModelAPI | null {
  const g = globalThis as typeof globalThis & { LanguageModel?: LanguageModelAPI };
  return g.LanguageModel ?? null;
}

export async function chromeAvailability(): Promise<PromptAvailability | "missing"> {
  const LanguageModel = getLanguageModel();
  if (!LanguageModel) return "missing";

  if (isEdgeBrowser()) {
    try {
      const status = await LanguageModel.availability();
      cachedNativeOpts = {};
      nativeImageOk = false;
      return status;
    } catch {
      return "missing";
    }
  }

  try {
    const vis = await LanguageModel.availability(CHROME_PROMPT_OPTS_VISION);
    if (usable(vis)) {
      cachedNativeOpts = { ...CHROME_PROMPT_OPTS_VISION };
      nativeImageOk = true;
      return vis;
    }
  } catch {
    /* text-only fallback */
  }

  try {
    const text = await LanguageModel.availability(CHROME_PROMPT_OPTS);
    cachedNativeOpts = { ...CHROME_PROMPT_OPTS };
    nativeImageOk = false;
    return text;
  } catch {
    try {
      const bare = await LanguageModel.availability();
      cachedNativeOpts = {};
      nativeImageOk = false;
      return bare;
    } catch {
      return "missing";
    }
  }
}

/** Built-in model name for UI labels (same Prompt API, different browser model). */
export function nativePromptModelLabel(): string {
  if (isEdgeBrowser()) return "Phi-4-mini";
  return "Gemini Nano";
}

/** Summarizer API (Chrome 138+). Same Nano download family as Prompt. */
export type SummarizerLike = {
  summarize: (input: string) => Promise<string>;
  destroy?: () => void;
};

type SummarizerAPI = {
  availability: (options?: Record<string, unknown>) => Promise<PromptAvailability>;
  create: (options?: Record<string, unknown>) => Promise<SummarizerLike>;
};

const SUMMARIZER_OPTS = {
  type: "tldr" as const,
  format: "plain-text" as const,
  length: "short" as const,
  expectedInputLanguages: ["en"] as string[],
  outputLanguage: "en",
};

export function getSummarizer(): SummarizerAPI | null {
  const g = globalThis as typeof globalThis & { Summarizer?: SummarizerAPI };
  return g.Summarizer ?? null;
}

export async function summarizerAvailability(): Promise<PromptAvailability | "missing"> {
  const Summarizer = getSummarizer();
  if (!Summarizer) return "missing";
  try {
    return await Summarizer.availability(SUMMARIZER_OPTS);
  } catch {
    try {
      return await Summarizer.availability();
    } catch {
      return "missing";
    }
  }
}

/** Must run in the same user-gesture turn as Prompt create when downloading. */
export function trySummarizerFromGesture(
  onProgress?: (pct: number) => void,
): Promise<SummarizerLike | null> {
  const Summarizer = getSummarizer();
  if (!Summarizer) return Promise.resolve(null);
  try {
    return Summarizer.create({
      ...SUMMARIZER_OPTS,
      monitor(m: {
        addEventListener: (type: "downloadprogress", listener: (e: DownloadProgressEvent) => void) => void;
      }) {
        m.addEventListener("downloadprogress", (e) => {
          const pct =
            e.total && e.total > 0
              ? Math.min(100, Math.round((e.loaded / e.total) * 100))
              : Math.min(100, Math.round((e.loaded <= 1 ? e.loaded : e.loaded / 100) * 100));
          onProgress?.(pct);
        });
      },
    }).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

