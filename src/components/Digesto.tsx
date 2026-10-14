import { useEffect, useRef, useState } from "react";
import type { TalkData } from "../data/types";
import { SCROLLY_STEP_IDS } from "../content/steps";
import type { Agent } from "../digesto/office/agent";
import type * as Runtime from "../digesto/runtime";
import { nativePromptModelLabel } from "../digesto/chrome-prompt";
import { snapshotStepChart } from "../digesto/snapshot";
import { WLLAMA_MODEL_IDS, WLLAMA_MODELS, type WllamaModelId } from "../digesto/prompts";
import {
  cueOrCanned,
  factsForStep,
  type DirectorCue,
} from "../digesto/director";
import type { ToolResult } from "../digesto/tools";
import { getLocale, LOCALE_EVENT, messages, t } from "../i18n";
import "./Digesto.css";

type Phase = "idle" | "choose" | "unsupported" | "loading" | "ready" | "error";
type LoadChoice = "native" | WllamaModelId;

const DWELL_MS = 1200;
const CUE_HOLD_MS = 8000;
const cueCache = new Map<string, DirectorCue>();

type Props = {
  enabled?: boolean;
  activeStepIndex?: number;
  data?: TalkData | null;
  onRestartScrolly?: () => void;
};

function citationsFooter(citations: ToolResult[]): string | undefined {
  if (!import.meta.env.DEV) return undefined;
  if (!citations.length) return undefined;
  const body = citations
    .map((c) => `${c.name}: ${c.content.slice(0, 280)}`)
    .join("\n\n");
  return `<details><summary>${t("digesto.sourcesDev")}</summary><pre>${escapeHtml(body)}</pre></details>`;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isWllamaModelId(id: string): id is WllamaModelId {
  return id in WLLAMA_MODELS;
}

export function Digesto({
  enabled = true,
  activeStepIndex = 0,
  data = null,
  onRestartScrolly,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<Agent | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const busyRef = useRef(false);
  const loadBusy = useRef(false);
  const runtimeRef = useRef<typeof Runtime | null>(null);
  const canTryNativeRef = useRef(false);
  const canTryWllamaRef = useRef(false);
  const askOpenRef = useRef(false);
  const cueAbort = useRef<AbortController | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const onRestartRef = useRef(onRestartScrolly);
  onRestartRef.current = onRestartScrolly;
  const lastStepRef = useRef<string | null>(null);
  const [readyTick, setReadyTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;

    const syncHostAria = () => {
      host.setAttribute("aria-label", t("digesto.hostAria"));
      const agent = agentRef.current;
      if (agent && phaseRef.current === "ready") {
        agent.setSuggestions(messages().digesto.exampleQuestions, (q) => {
          void handleAsk(q);
        });
      }
    };
    const onLocale = () => {
      syncHostAria();
      if (phaseRef.current === "ready") setReadyTick((n) => n + 1);
    };
    syncHostAria();
    window.addEventListener(LOCALE_EVENT, onLocale);

    (async () => {
      try {
        const { initAgent } = await import("../digesto/office/agent");
        const { digestoLoaders } = await import("../digesto/agents/digesto");
        if (cancelled || !hostRef.current) return;

        host.style.display = "block";
        const agent = await initAgent(
          digestoLoaders,
          host,
          (text) => {
            void handleAsk(text);
          },
          () => {
            handleInputActivate();
          },
        );
        if (cancelled) {
          agent.dispose();
          return;
        }
        agentRef.current = agent;
        agent.setOnClick(() => handleAgentClick());
        agent.setOnClose(() => {
          askOpenRef.current = false;
          setReadyTick((n) => n + 1);
        });
        await agent.show();
        void agent.play("Wave");

        const runtime = await import("../digesto/runtime");
        runtimeRef.current = runtime;
        if (cancelled) return;

        const probe = await runtime.probeLocalModels();
        canTryNativeRef.current = probe.canTryChrome;
        canTryWllamaRef.current = probe.canTryWllama;
        if (!runtime.anyModelPossible(probe)) {
          phaseRef.current = "unsupported";
          void agent.play("Confused");
        } else {
          phaseRef.current = "choose";
        }
      } catch (e) {
        console.error("[Digesto]", e);
        if (cancelled) return;
        phaseRef.current = "error";
        void agentRef.current?.play("Confused");
      }
    })();

    function openSveglia() {
      const agent = agentRef.current;
      if (!agent) return;
      if (canTryNativeRef.current) {
        const model = nativePromptModelLabel();
        agent.openChoices(t("digesto.sveglia"), [
          {
            id: "native",
            label: t("digesto.svegliaNative", { model }),
            hint: t("digesto.choiceNativeHint"),
          },
        ], (id) => {
          if (id === "native") startLoad("native");
        });
        return;
      }
      openWllamaCatalog();
    }

    function openWllamaCatalog() {
      const agent = agentRef.current;
      if (!agent) return;
      const choices: Array<{ id: string; label: string; hint?: string }> = [];
      if (canTryWllamaRef.current) {
        for (const id of WLLAMA_MODEL_IDS) {
          const m = WLLAMA_MODELS[id];
          choices.push({
            id: m.id,
            label: m.label,
            hint: t("digesto.choiceSizeHint", { size: m.sizeMb }),
          });
        }
      }
      if (!choices.length) {
        agent.openNotice(t("digesto.unsupported"));
        return;
      }
      agent.openChoices(t("digesto.welcomeChoose"), choices, (id) => {
        if (isWllamaModelId(id)) startLoad(id);
      });
    }

    function startLoad(choice: LoadChoice) {
      const agent = agentRef.current;
      const runtime = runtimeRef.current;
      if (!agent || !runtime || loadBusy.current) return;
      if (runtime.isBackendReady()) {
        phaseRef.current = "ready";
        setReadyTick((n) => n + 1);
        return;
      }

      loadBusy.current = true;
      phaseRef.current = "loading";
      agent.hideChoices();
      agent.showInput(false);
      const nativeLabel = nativePromptModelLabel();
      if (choice === "native") {
        agent.setMessage(t("digesto.loadingNative", { model: nativeLabel }));
        void runtime.startSummarizerFromGesture();
      } else {
        agent.setMessage(t("digesto.loadingPct", { pct: 0 }));
      }

      const loadPromise = runtime.loadModel(choice, (p) => {
        agent.setMessage(p);
      });
      void agent.play("Thinking");

      void loadPromise
        .then(async (r) => {
          if (r.ok) {
            phaseRef.current = "ready";
            agent.setSuggestions(messages().digesto.exampleQuestions, (q) => {
              void handleAsk(q);
            });
            await agent.play("Wave");
            agent.openChoices(t("digesto.invite"), [
              { id: "restart", label: t("digesto.restart") },
            ], (id) => {
              if (id === "restart") onRestartRef.current?.();
            });
            setReadyTick((n) => n + 1);
          } else {
            phaseRef.current = "choose";
            agent.resetChromeActivateGate();
            agent.openNotice(r.reason || t("digesto.unsupported"));
            void agent.play("Sad");
          }
        })
        .catch((e) => {
          phaseRef.current = "error";
          agent.resetChromeActivateGate();
          agent.openNotice(e instanceof Error ? e.message : t("digesto.unsupported"));
          void agent.play("Confused");
        })
        .finally(() => {
          loadBusy.current = false;
        });
    }

    function handleAgentClick() {
      const agent = agentRef.current;
      if (!agent) return;
      if (phaseRef.current === "idle") return;

      if (phaseRef.current === "unsupported" || phaseRef.current === "error") {
        agent.openNotice(t("digesto.unsupported"));
        return;
      }
      if (phaseRef.current === "loading") {
        agent.openNotice(t("digesto.loadingModel"));
        return;
      }
      if (phaseRef.current === "ready") {
        cueAbort.current?.abort();
        agent.cancelCue();
        askOpenRef.current = true;
        agent.openAsk(t("digesto.readyAsk"));
        return;
      }
      openSveglia();
    }

    function handleInputActivate() {
      const agent = agentRef.current;
      const runtime = runtimeRef.current;
      if (!agent || !runtime || loadBusy.current) return;
      if (runtime.isBackendReady()) {
        phaseRef.current = "ready";
        return;
      }
      if (phaseRef.current === "unsupported" || phaseRef.current === "error") {
        return;
      }
      if (phaseRef.current === "idle" || phaseRef.current === "loading") return;
      openSveglia();
    }

    async function handleAsk(text: string) {
      const agent = agentRef.current;
      const runtime = runtimeRef.current;
      if (!agent || busyRef.current) return;

      if (phaseRef.current === "unsupported" || phaseRef.current === "error") {
        agent.openNotice(t("digesto.unsupported"));
        return;
      }
      if (phaseRef.current === "loading") {
        agent.setMessage(t("digesto.loadingModel"));
        return;
      }
      if (phaseRef.current === "choose" || phaseRef.current === "idle" || !runtime?.isBackendReady()) {
        openSveglia();
        return;
      }

      busyRef.current = true;
      askOpenRef.current = true;
      try {
        agent.setMessage(t("digesto.thinking"), undefined, text);
        void agent.play("Thinking");
        const { askDigesto } = await import("../digesto/runtime");
        const { answer, citations, chart } = await askDigesto(text);
        await agent.play("Congratulate");
        await agent.speak(answer, {
          question: text,
          footerHtml: citationsFooter(citations),
          chart,
        });
      } catch (e) {
        await agent.play("Confused");
        await agent.speak(e instanceof Error ? e.message : t("common.error"), {
          question: text,
        });
      } finally {
        busyRef.current = false;
      }
    }

    return () => {
      cancelled = true;
      window.removeEventListener(LOCALE_EVENT, onLocale);
      cueAbort.current?.abort();
      agentRef.current?.dispose();
      agentRef.current = null;
      runtimeRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (phaseRef.current !== "ready") return;
    if (askOpenRef.current) return;
    const talk = dataRef.current;
    const agent = agentRef.current;
    const runtime = runtimeRef.current;
    if (!talk || !agent || !runtime) return;

    const stepId = SCROLLY_STEP_IDS[activeStepIndex] ?? SCROLLY_STEP_IDS[0];
    const locale = getLocale();
    const cacheKey = `${stepId}:${locale}`;
    const cached = cueCache.get(cacheKey);
    const sameStep = lastStepRef.current === stepId;
    lastStepRef.current = stepId;
    const delay = cached && sameStep ? 0 : DWELL_MS;

    cueAbort.current?.abort();
    const ac = new AbortController();
    cueAbort.current = ac;

    const timer = window.setTimeout(() => {
      void (async () => {
        if (ac.signal.aborted || askOpenRef.current) return;
        if (cached) {
          void agent.speakCue(cached.line, cached.animation, CUE_HOLD_MS);
          return;
        }
        const facts = factsForStep(stepId, talk);
        agent.showPending();
        const image =
          runtime.usingChrome() && runtime.nativeSupportsImage()
            ? await snapshotStepChart()
            : null;
        const parsed = await runtime.directorCueFromModel(
          stepId,
          facts,
          locale,
          ac.signal,
          image,
        );
        if (ac.signal.aborted || askOpenRef.current) return;
        const cue = cueOrCanned(parsed, stepId, facts, locale);
        cueCache.set(cacheKey, cue);
        void agent.speakCue(cue.line, cue.animation, CUE_HOLD_MS);
      })();
    }, delay);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
      agent.cancelCue();
    };
  }, [enabled, activeStepIndex, readyTick]);

  if (!enabled) return null;

  return (
    <div
      ref={hostRef}
      className="digesto-host"
      aria-label={t("digesto.hostAria")}
    />
  );
}
