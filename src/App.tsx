import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { loadManifest, loadTalkData, prefetchExploreData } from "./data/load";
import type { Manifest, TalkData } from "./data/types";
import { SCROLLY_STEP_IDS } from "./content/steps";
import type { RemixSpec } from "./digesto/remix";
import { useI18n } from "./i18n";
import { Hero } from "./components/Hero";
import { Scrolly } from "./components/Scrolly";
import { BootSplash } from "./components/BootSplash";
import { ExploreLoading } from "./components/ExploreLoading";
import { ChromeToggles } from "./components/ChromeToggles";
import "./App.css";

const Explore = lazy(() =>
  import("./components/Explore").then((m) => ({ default: m.Explore })),
);
const Gazzetta = lazy(() =>
  import("./components/Gazzetta").then((m) => ({ default: m.Gazzetta })),
);
const Digesto = lazy(() =>
  import("./components/Digesto").then((m) => ({ default: m.Digesto })),
);
const RemixModal = lazy(() =>
  import("./components/RemixModal").then((m) => ({ default: m.RemixModal })),
);

const CLOSE_STEP = SCROLLY_STEP_IDS.length - 1;
const PREFETCH_STEP = Math.max(0, CLOSE_STEP - 1);

function useDesktop() {
  const [desktop, setDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 900px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

function endBoot() {
  document.documentElement.classList.remove("boot");
}

export function App() {
  const { t } = useI18n();
  const [data, setData] = useState<TalkData | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scrollReady, setScrollReady] = useState(false);
  const [heavy, setHeavy] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [remix, setRemix] = useState<{ spec: RemixSpec; clusterComp?: string } | null>(
    null,
  );
  const [gazzettaOpen, setGazzettaOpen] = useState(false);
  const desktop = useDesktop();

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadTalkData(), loadManifest()])
      .then(([talk, man]) => {
        if (cancelled) return;
        setData(talk);
        setManifest(man);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message);
          endBoot();
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onScrollyReady = useCallback(() => {
    setScrollReady(true);
    endBoot();
  }, []);

  const onActiveChange = useCallback((index: number) => {
    setActiveStep(index);
    if (index >= PREFETCH_STEP) {
      prefetchExploreData();
      void import("./components/Explore");
      void import("./components/Digesto");
    }
    if (index >= CLOSE_STEP) setHeavy(true);
  }, []);

  const restartScrolly = useCallback(() => {
    const el = document.querySelector<HTMLElement>(".scrolly-step");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const openRemix = useCallback((spec: RemixSpec, clusterComp?: string) => {
    setRemix({ spec, clusterComp });
  }, []);

  if (error) {
    return (
      <>
        <ChromeToggles />
        <main className="app-error">
          <h1>{t("brand.name")}</h1>
          <p>{error}</p>
          <p className="muted">{t("app.errorRefreshHint")}</p>
        </main>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <ChromeToggles />
        <BootSplash />
      </>
    );
  }

  return (
    <>
      <ChromeToggles onSouvenir={scrollReady ? () => setGazzettaOpen(true) : undefined} />
      <div className="app" aria-busy={!scrollReady} inert={!scrollReady || undefined}>
        <Hero asOf={manifest?.asOf ?? data.dateRange.last} totals={data.totals} />
        <Scrolly
          data={data}
          onReady={onScrollyReady}
          onActiveChange={onActiveChange}
          onRemix={openRemix}
        />
        {desktop && heavy ? (
          <Suspense fallback={<ExploreLoading />}>
            <Explore data={data} onRemix={openRemix} />
          </Suspense>
        ) : null}
        {heavy ? (
          <Suspense fallback={null}>
            <Digesto
              enabled
              data={data}
              activeStepIndex={activeStep}
              onRestartScrolly={restartScrolly}
            />
          </Suspense>
        ) : null}
      </div>
      {gazzettaOpen ? (
        <Suspense fallback={null}>
          <Gazzetta
            data={data}
            asOf={manifest?.asOf ?? data.dateRange.last}
            onClose={() => setGazzettaOpen(false)}
          />
        </Suspense>
      ) : null}
      {remix ? (
        <Suspense fallback={null}>
          <RemixModal
            data={data}
            initialSpec={remix.spec}
            clusterComp={remix.clusterComp}
            onClose={() => setRemix(null)}
          />
        </Suspense>
      ) : null}
      {!scrollReady ? (
        <div className="scroll-gate" role="status" aria-live="polite">
          <BootSplash message={t("boot.scrollPrep")} />
        </div>
      ) : null}
    </>
  );
}
