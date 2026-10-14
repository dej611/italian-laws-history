import { useEffect, useMemo, useRef, useState } from "react";
import type { ActsIndex, GraphData, TalkData } from "../data/types";
import { loadActs, loadGraph } from "../data/load";
import { DIGESTO_READY_EVENT } from "../digesto/ready-event";
import {
  cannedRubrica,
  clampGazzettaYear,
  featuredForYear,
  GAZZETTA_CHIPS,
  yearFacts,
  type FeaturedAct,
  type YearFacts,
} from "../digesto/gazzetta";
import { formatNumber, LOCALE_EVENT, useI18n } from "../i18n";
import "./Gazzetta.css";

type Props = {
  data: TalkData;
  asOf?: string;
  onClose: () => void;
};

function formatActDate(iso: string | null, locale: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale === "en" ? "en-GB" : "it-IT", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function vsMeanLabel(
  total: number,
  mean: number,
  t: (p: string, v?: Record<string, string | number>) => string,
): string {
  const pct = mean <= 0 ? 0 : Math.round((100 * (total - mean)) / mean);
  if (Math.abs(pct) < 8) return t("gazzetta.vsMeanFlat");
  if (pct > 0) return t("gazzetta.vsMeanUp", { pct });
  return t("gazzetta.vsMeanDown", { pct });
}

function Seal({ year, eraLabel, archive }: { year: number; eraLabel: string; archive: string }) {
  return (
    <svg className="gazzetta-seal" viewBox="0 0 160 160" aria-hidden>
      <circle cx="80" cy="80" r="74" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle className="gazzetta-seal-inner" cx="80" cy="80" r="66" fill="none" strokeWidth="1.2" />
      <text x="80" y="48" textAnchor="middle" className="gazzetta-seal-kicker">
        NORMOSCOPIO
      </text>
      <text x="80" y="92" textAnchor="middle" className="gazzetta-seal-year">
        {year}
      </text>
      <text x="80" y="114" textAnchor="middle" className="gazzetta-seal-era">
        {eraLabel}
      </text>
      <text x="80" y="132" textAnchor="middle" className="gazzetta-seal-foot">
        {archive}
      </text>
    </svg>
  );
}

function Spark({ facts }: { facts: YearFacts }) {
  const w = 720;
  const h = 120;
  const pad = { l: 8, r: 8, t: 8, b: 22 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const max = Math.max(1, ...facts.spark.map((s) => s.n));
  const bw = facts.spark.length ? iw / facts.spark.length : iw;
  return (
    <svg className="gazzetta-spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-hidden>
      {facts.spark.map((s, i) => {
        const bh = (s.n / max) * ih;
        const x = pad.l + i * bw;
        const on = s.year === facts.year;
        return (
          <g key={s.year}>
            <rect
              x={x + 2}
              y={pad.t + ih - bh}
              width={Math.max(1, bw - 4)}
              height={bh}
              className={on ? "is-on" : undefined}
            />
            {on || i === 0 || i === facts.spark.length - 1 ? (
              <text x={x + bw / 2} y={h - 6} textAnchor="middle">
                {s.year}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function Gazzetta({ data, asOf, onClose }: Props) {
  const { t, locale } = useI18n();
  const first = data.dateRange.firstEnactYear;
  const last = data.dateRange.lastEnactYear;
  const [year, setYear] = useState(() => clampGazzettaYear(1975, first, last));
  const [draft, setDraft] = useState(String(clampGazzettaYear(1975, first, last)));
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [acts, setActs] = useState<ActsIndex | null>(null);
  const [rubrica, setRubrica] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const facts = useMemo(() => yearFacts(data, year), [data, year]);
  const feat = useMemo(
    () => (graph && acts ? featuredForYear(graph, acts, facts.year) : { act: null as FeaturedAct | null, hubs: 0 }),
    [graph, acts, facts.year],
  );
  const canned = useMemo(
    () => cannedRubrica(facts, feat.act, locale),
    [facts, feat.act, locale],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadGraph(), loadActs()]).then(([g, a]) => {
      if (cancelled) return;
      setGraph(g);
      setActs(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setDraft(String(facts.year));
  }, [facts.year]);

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRubrica(canned);
    setPending(false);
    let cancelled = false;

    const run = () => {
      void import("../digesto/runtime").then(async (rt) => {
        if (cancelled || ac.signal.aborted) return;
        if (!rt.isBackendReady()) {
          setPending(false);
          return;
        }
        setPending(true);
        const line = await rt.gazzettaRubricaFromModel(facts, feat.act, locale, ac.signal);
        if (cancelled || ac.signal.aborted) return;
        if (line) setRubrica(line);
        setPending(false);
      });
    };

    run();
    const onReady = () => run();
    window.addEventListener(DIGESTO_READY_EVENT, onReady);
    window.addEventListener(LOCALE_EVENT, onReady);
    return () => {
      cancelled = true;
      ac.abort();
      window.removeEventListener(DIGESTO_READY_EVENT, onReady);
      window.removeEventListener(LOCALE_EVENT, onReady);
    };
  }, [canned, facts, feat.act, locale]);

  const commitYear = (raw: string | number) => {
    const n = typeof raw === "number" ? raw : Number(raw);
    setYear(clampGazzettaYear(n, first, last));
  };

  const eraLabel = t(`chart.eras.${facts.era}`);
  const n = (x: number) => formatNumber(x, locale);
  const dlAll = facts.dlConvertito + facts.dlDecaduto;
  const mixTotal = Math.max(1, facts.total);

  return (
    <div
      className="gazzetta-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("gazzetta.ariaLabel")}
      onClick={onClose}
    >
      <div className="gazzetta" id="gazzetta" onClick={(e) => e.stopPropagation()}>
        <header className="gazzetta-head">
          <div>
            <h2>{t("gazzetta.title")}</h2>
            <p>{t("gazzetta.lede")}</p>
          </div>
          <button type="button" className="gazzetta-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </header>

      <div className="gazzetta-chips" role="group" aria-label={t("gazzetta.yearLabel")}>
        {GAZZETTA_CHIPS.filter((y) => y >= first && y <= last).map((y) => (
          <button
            key={y}
            type="button"
            className={y === facts.year ? "is-on" : undefined}
            onClick={() => commitYear(y)}
          >
            {y}
          </button>
        ))}
        <label className="gazzetta-year-input">
          <span className="visually-hidden">{t("gazzetta.yearLabel")}</span>
          <input
            type="number"
            min={first}
            max={last}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitYear(draft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitYear(draft);
            }}
          />
        </label>
      </div>

      <article className="gazzetta-sheet">
        <div className="gazzetta-sheet-top">
          <div>
            <p className="gazzetta-kicker">{t("gazzetta.kicker")}</p>
            <h3>{t("gazzetta.yearLabel")} {facts.year}</h3>
            <p className="gazzetta-asof">
              {t("gazzetta.asOf", {
                corpus: n(data.totals.acts),
                asOf: asOf ?? data.dateRange.last,
              })}
            </p>
          </div>
          <Seal year={facts.year} eraLabel={eraLabel} archive={t("gazzetta.sealArchive")} />
        </div>

        <p className="gazzetta-rubrica">
          {pending && !rubrica ? t("gazzetta.rubricaPending") : rubrica ?? canned}
        </p>

        <div className="gazzetta-mix" aria-label={t("gazzetta.mixLabel")}>
          <div className="gazzetta-mix-bar">
            <i style={{ width: `${(100 * facts.parlamento) / mixTotal}%` }} className="is-parlamento" />
            <i style={{ width: `${(100 * facts.governo) / mixTotal}%` }} className="is-governo" />
            <i style={{ width: `${(100 * facts.altro) / mixTotal}%` }} className="is-altro" />
          </div>
          <ul>
            <li>
              {t("chart.channels.parlamento")}: {n(facts.parlamento)}
            </li>
            <li>
              {t("chart.channels.governo")}: {n(facts.governo)}
            </li>
            <li>
              {t("chart.channels.altro")}: {n(facts.altro)}
            </li>
          </ul>
        </div>

        <p className="gazzetta-mean">{vsMeanLabel(facts.total, facts.corpusMean, t)}</p>

        {dlAll > 0 ? (
          <p className="gazzetta-dl">
            {t("gazzetta.dlLine", {
              dlConvertito: n(facts.dlConvertito),
              dlDecaduto: n(facts.dlDecaduto),
              dlLapsePct: Math.round((100 * facts.dlDecaduto) / dlAll),
            })}
          </p>
        ) : null}

        <div className="gazzetta-spark-wrap">
          <p className="gazzetta-spark-label">{t("gazzetta.volumeCaption")}</p>
          <Spark facts={facts} />
        </div>

        <footer className="gazzetta-featured">
          <p className="gazzetta-featured-kicker">{t("gazzetta.featured")}</p>
          {feat.act ? (
            <>
              <p className="gazzetta-featured-title">{feat.act.label}</p>
              <p>
                {t("gazzetta.featuredMeta", {
                  date: formatActDate(feat.act.enactDate, locale),
                  degree: n(feat.act.degree),
                  hubs: n(feat.hubs),
                })}
              </p>
            </>
          ) : (
            <p>{t("gazzetta.featuredNone")}</p>
          )}
        </footer>

        <p className="gazzetta-note">{t("gazzetta.archiveNote")}</p>
      </article>
      </div>
    </div>
  );
}
