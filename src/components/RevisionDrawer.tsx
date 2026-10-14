import { useEffect, useState } from "react";
import type { ActMeta, BlameFile, GraphNode } from "../data/types";
import { dataUrl, loadRagExcerpt } from "../data/load";
import { extractiveSummary } from "../digesto/act-blurb";
import {
  changeArc,
  type PrintKind,
  type TreeEntry,
} from "../digesto/fingerprint";
import type { RemixSpec } from "../digesto/remix";
import { DEFAULT_REMIX } from "../digesto/remix";
import { DIGESTO_READY_EVENT } from "../digesto/ready-event";
import { ActPrint } from "./ActPrint";
import { RemixButton } from "./RemixButton";
import { t, type Locale, getLocale } from "../i18n";
import "./RevisionDrawer.css";

type Props = {
  slug: string | null;
  act?: ActMeta | null;
  node?: GraphNode | null;
  onClose: () => void;
  onRemix?: (spec: RemixSpec, clusterComp?: string) => void;
};

/** Date from the commit title (GU / @ …), not git author date. */
function dateFromSubject(subject: string, fallback: string): string {
  const at = subject.match(/@\s*(\d{4}-\d{2}-\d{2})\b/);
  if (at) return at[1];
  const gu = subject.match(/^GU\s+\S+\s+-\s+(\d{4}-\d{2}-\d{2})\b/);
  if (gu) return gu[1];
  const any = subject.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (any) return any[1];
  return fallback.slice(0, 10);
}

function yearOf(date: string, fallback: number | null): number {
  const y = Number(date.slice(0, 4));
  if (Number.isFinite(y) && y > 1800) return y;
  return fallback ?? 0;
}

const ERA_ORDER = ["unita", "fascismo", "repubblica", "seconda"] as const;

function arcLine(entries: TreeEntry[], locale: Locale): string {
  const arc = changeArc(entries);
  if (!entries.length) return t("revision.excerptMissing", undefined, locale);
  const bits: string[] = [];
  for (const era of ERA_ORDER) {
    const n = arc.byEra[era];
    if (!n) continue;
    bits.push(t(`revision.arcEra.${era}`, { n }, locale));
  }
  const eraBits = bits.join(", ");
  const first = arc.firstYear ?? "—";
  const last = arc.lastYear ?? first;
  if (arc.modifica + arc.convertito === 0) {
    return t("revision.arcNone", { year: first }, locale);
  }
  const body = t("revision.arc", {
    first,
    last,
    modifiche: arc.modifica + arc.convertito,
    eraBits,
  }, locale);
  if (arc.decadutoYear) {
    return `${body} ${t("revision.arcLapsed", { decaduto: arc.decadutoYear }, locale)}`;
  }
  return body;
}

export function RevisionDrawer({ slug, act, node, onClose, onRemix }: Props) {
  const [blame, setBlame] = useState<BlameFile | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "missing" | "ok">("idle");
  const [wear, setWear] = useState(0);
  const [excerpt, setExcerpt] = useState<string | null>(null);
  const [excerptReady, setExcerptReady] = useState(false);
  const [blurb, setBlurb] = useState<{ summary: string | null; changes: string | null } | null>(
    null,
  );
  const [blurbBusy, setBlurbBusy] = useState(false);

  useEffect(() => {
    if (!slug) {
      setBlame(null);
      setStatus("idle");
      setWear(0);
      setExcerpt(null);
      setExcerptReady(false);
      setBlurb(null);
      setBlurbBusy(false);
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setWear(0);
    setExcerpt(null);
    setExcerptReady(false);
    setBlurb(null);
    setBlurbBusy(false);
    fetch(dataUrl(`/data/blame/${encodeURIComponent(slug)}.json`))
      .then(async (r) => {
        if (!r.ok) throw new Error("missing");
        return r.json() as Promise<BlameFile>;
      })
      .then((b) => {
        if (cancelled) return;
        setBlame(b);
        setWear(Math.max(0, b.entries.length - 1));
        setStatus("ok");
      })
      .catch(() => {
        if (cancelled) return;
        setBlame(null);
        setStatus("missing");
      });
    void loadRagExcerpt(slug).then((text) => {
      if (!cancelled) {
        setExcerpt(text);
        setExcerptReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!slug || !excerptReady) return;
    let cancelled = false;
    const locale = getLocale();
    const title = slug.replace(/\.txt$/, "").replace(/-/g, " ");
    const tree: TreeEntry[] = (blame?.entries ?? []).map((e) => ({
      year: yearOf(dateFromSubject(e.subject, e.date), act?.enactYear ?? null),
      kind: e.kind as PrintKind,
    }));
    const changes = tree.length ? arcLine(tree, locale) : null;
    const fallbackSummary = excerpt ? extractiveSummary(excerpt) : null;
    setBlurb({ summary: null, changes });
    setBlurbBusy(Boolean(excerpt));

    const run = () => {
      if (cancelled) return;
      if (!excerpt) {
        setBlurbBusy(false);
        setBlurb({ summary: null, changes });
        return;
      }
      void import("../digesto/runtime").then(async (rt) => {
        if (cancelled) return;
        if (!rt.isBackendReady()) {
          setBlurbBusy(false);
          setBlurb({ summary: fallbackSummary, changes });
          return;
        }
        setBlurb({ summary: null, changes });
        setBlurbBusy(true);
        const upgraded = await rt.summarizeAct(title, excerpt, changes ?? "", locale);
        if (cancelled) return;
        setBlurbBusy(false);
        if (upgraded) setBlurb(upgraded);
        else setBlurb({ summary: fallbackSummary, changes });
      });
    };
    run();
    window.addEventListener(DIGESTO_READY_EVENT, run);
    return () => {
      cancelled = true;
      window.removeEventListener(DIGESTO_READY_EVENT, run);
    };
  }, [slug, excerpt, excerptReady, blame, act?.enactYear]);

  if (!slug) return null;

  const title = slug.replace(/\.txt$/, "").replace(/-/g, " ");
  const kindLabel = (kind: string) => {
    const key = `revision.kind.${kind}`;
    const label = t(key);
    return label === key ? kind : label;
  };
  const entries = blame?.entries ?? [];
  const tree: TreeEntry[] = entries.map((e) => ({
    year: yearOf(dateFromSubject(e.subject, e.date), act?.enactYear ?? null),
    kind: e.kind as PrintKind,
  }));

  return (
    <aside className="revision-drawer" aria-label={t("revision.title")}>
      <div className="revision-drawer-sticky">
        <header className="revision-drawer-head">
          <div>
            <p className="eyebrow">{t("revision.title")}</p>
            <div className="section-title-row">
              <h3>{title}</h3>
              {onRemix ? (
                <RemixButton
                  onClick={() => onRemix({ ...DEFAULT_REMIX }, node?.comp)}
                />
              ) : null}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")}>
            {t("common.close")}
          </button>
        </header>
        <ActPrint
          enactYear={act?.enactYear ?? null}
          entries={tree}
          wearIndex={wear}
        />
      </div>
      <div className="revision-drawer-body">
      {blurb?.summary ? (
        <blockquote className="revision-excerpt">
          <p className="revision-excerpt-label">{t("revision.summaryLabel")}</p>
          <p>{blurb.summary}</p>
        </blockquote>
      ) : excerptReady && status === "ok" && !excerpt ? (
        <p className="muted">{t("revision.excerptMissing")}</p>
      ) : blurbBusy ? (
        <p className="revision-excerpt-label">{t("revision.summaryPending")}</p>
      ) : null}
      {blurb?.changes ? (
        <p className="revision-arc">
          <span className="revision-excerpt-label">{t("revision.changesLabel")}</span>
          {blurb.changes}
        </p>
      ) : null}
      {status === "loading" ? <p className="muted">{t("revision.loading")}</p> : null}
      {status === "missing" ? <p className="muted">{t("revision.missing")}</p> : null}
      {status === "ok" && blame ? (
        <ol className="revision-list">
          {blame.entries.map((e, i) => {
            const date = dateFromSubject(e.subject, e.date);
            return (
              <li
                key={`${date}-${i}`}
                className={i === wear ? "is-wear" : undefined}
                tabIndex={0}
                onMouseEnter={() => setWear(i)}
                onFocus={() => setWear(i)}
              >
                <time dateTime={date}>{date}</time>
                <span className="kind">{kindLabel(e.kind)}</span>
                <p>{e.subject}</p>
              </li>
            );
          })}
        </ol>
      ) : null}
      </div>
    </aside>
  );
}
