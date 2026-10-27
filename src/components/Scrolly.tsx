import { useEffect, useRef, useState } from "react";
import type { TalkData } from "../data/types";
import { useI18n } from "../i18n";
import type { RemixSpec } from "../digesto/remix";
import { specFromStep } from "../digesto/remix";
import { RemixButton } from "./RemixButton";
import { StepChart } from "./StepChart";
import "./Scrolly.css";

type Props = {
  data: TalkData;
  onReady?: () => void;
  onActiveChange?: (index: number) => void;
  onRemix?: (spec: RemixSpec, clusterComp?: string) => void;
};

function pickActiveStep(steps: (HTMLElement | null)[]): number {
  const bandY = window.innerHeight * 0.4;
  let best = 0;
  let bestDist = Infinity;
  for (const el of steps) {
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    const center = (rect.top + rect.bottom) / 2;
    const dist = Math.abs(center - bandY);
    if (dist < bestDist) {
      bestDist = dist;
      best = Number(el.dataset.index) || 0;
    }
  }
  return best;
}

export function Scrolly({ data, onReady, onActiveChange, onRemix }: Props) {
  const { t, steps, locale } = useI18n();
  const [active, setActive] = useState(0);
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const pendingRef = useRef<number | null>(null);
  const lastNotified = useRef(-1);
  const armedRef = useRef(false);
  const onReadyRef = useRef(onReady);
  const onActiveChangeRef = useRef(onActiveChange);
  onReadyRef.current = onReady;
  onActiveChangeRef.current = onActiveChange;

  const commitActive = (idx: number) => {
    setActive((prev) => (prev === idx ? prev : idx));
    if (lastNotified.current !== idx) {
      lastNotified.current = idx;
      onActiveChangeRef.current?.(idx);
    }
  };

  // Arm observer + scroll gate once. Do not re-run on locale/copy updates.
  useEffect(() => {
    let cancelled = false;
    const els = stepRefs.current;

    const sync = () => {
      commitActive(pickActiveStep(els));
    };

    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        const idx = Number((visible.target as HTMLElement).dataset.index);
        if (Number.isNaN(idx)) return;
        if (pendingRef.current != null) cancelAnimationFrame(pendingRef.current);
        pendingRef.current = requestAnimationFrame(() => {
          commitActive(idx);
        });
      },
      { rootMargin: "-35% 0px -40% 0px", threshold: [0.15, 0.35, 0.55, 0.75] },
    );

    for (const el of els) if (el) obs.observe(el);

    const onScroll = () => {
      if (pendingRef.current != null) cancelAnimationFrame(pendingRef.current);
      pendingRef.current = requestAnimationFrame(() => {
        commitActive(pickActiveStep(els));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    async function arm() {
      try {
        if (document.fonts?.ready) await document.fonts.ready;
      } catch {
        /* ignore */
      }
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
      if (cancelled) return;
      if (!armedRef.current) {
        window.scrollTo(0, 0);
        armedRef.current = true;
      }
      sync();
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (cancelled) return;
      sync();
      onReadyRef.current?.();
    }

    void arm();

    return () => {
      cancelled = true;
      obs.disconnect();
      window.removeEventListener("scroll", onScroll);
      if (pendingRef.current != null) cancelAnimationFrame(pendingRef.current);
    };
  }, []);

  // After a language switch, re-sync active step without jumping to top.
  useEffect(() => {
    if (!armedRef.current) return;
    commitActive(pickActiveStep(stepRefs.current));
  }, [locale, steps]);

  const phase = steps[active]?.phase ?? "volume";

  return (
    <section className="scrolly" aria-label={t("scrolly.ariaLabel")}>
      <div className="scrolly-chart-stage">
        <div className="scrolly-chart-inner">
          <StepChart data={data} phase={phase} />
        </div>
      </div>
      <div className="scrolly-steps">
        {steps.map((step, i) => (
          <article
            key={step.id}
            className={`scrolly-step${i === active ? " is-active" : ""}`}
            data-index={i}
            ref={(el) => {
              stepRefs.current[i] = el;
            }}
          >
            <div className="section-title-row">
              <h2>{step.headline}</h2>
              {onRemix && step.id !== "close" ? (
                <RemixButton onClick={() => onRemix(specFromStep(step.id))} />
              ) : null}
            </div>
            {step.body.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
