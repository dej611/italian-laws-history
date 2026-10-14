import { eraFromYear, revisionSpiral, spiralGridPoints, spiralGridSteps, type PrintKind, type TreeEntry } from "../digesto/fingerprint";
import { t } from "../i18n";
import "./ActPrint.css";

type Props = {
  enactYear: number | null;
  entries: TreeEntry[];
  wearIndex: number;
};

const ERA_FILL: Record<ReturnType<typeof eraFromYear>, string> = {
  unita: "#7a93a8",
  fascismo: "#a15c3a",
  repubblica: "#2f6b8a",
  seconda: "#3d7a6a",
};

const ERAS = ["unita", "fascismo", "repubblica", "seconda"] as const;

function gridPath(pts: { x: number; y: number }[]) {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}

export function ActPrint({ enactYear, entries, wearIndex }: Props) {
  const marks =
    entries.length > 0
      ? entries
      : enactYear != null
        ? [{ year: enactYear, kind: "gu" as PrintKind }]
        : [];
  const steps = spiralGridSteps(marks.length);
  const grid = spiralGridPoints(steps);
  const segs = revisionSpiral(marks);
  const wear = Math.max(0, Math.min(wearIndex, Math.max(0, segs.length - 1)));

  return (
    <figure className="act-print">
      <svg viewBox="0 0 200 200" aria-label={t("revision.printAria")} role="img">
        <rect x="0" y="0" width="200" height="200" fill="var(--paper-deep, #e4eaef)" />
        <g className="act-print-grid" aria-hidden="true">
          <path d={gridPath(grid)} fill="none" />
          {grid.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={1.15} />
          ))}
        </g>
        {segs.map((s) => {
          const future = s.i > wear;
          return (
            <g key={s.i} opacity={future ? 0.18 : 1}>
              {s.i > 0 ? (
                <line
                  x1={s.x1}
                  y1={s.y1}
                  x2={s.x2}
                  y2={s.y2}
                  stroke={ERA_FILL[s.era]}
                  strokeWidth={2.2}
                  strokeLinecap="round"
                />
              ) : null}
              <circle
                cx={s.cx}
                cy={s.cy}
                r={s.i === wear ? 5.2 : 3.2}
                fill={ERA_FILL[s.era]}
                stroke={s.i === wear ? "var(--ink, #1a2433)" : "var(--paper, #f7f4ef)"}
                strokeWidth={s.i === wear ? 1.4 : 0.8}
              />
              {s.kind === "decaduto" ? (
                <line
                  x1={s.cx - 5}
                  y1={s.cy + 5}
                  x2={s.cx + 5}
                  y2={s.cy - 5}
                  stroke="var(--ink, #1a2433)"
                  strokeWidth={1.2}
                  opacity={0.55}
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      <ul className="act-print-legend" aria-hidden>
        {ERAS.map((era) => (
          <li key={era}>
            <i style={{ background: ERA_FILL[era] }} />
            {t(`chart.eras.${era}`)}
          </li>
        ))}
      </ul>
      <p className="act-print-hint">{t("revision.captionHint")}</p>
    </figure>
  );
}
