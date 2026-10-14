import { useId } from "react";
import { useI18n } from "../i18n";
import { GAVEL_BANDS, GAVEL_PARTS } from "./gavelPath";
import "./BootSplash.css";

type Props = {
  message?: string;
  compact?: boolean;
  quiet?: boolean;
};

function GavelMark({ clipId }: { clipId: string }) {
  const { head, shaft, pommel } = GAVEL_PARTS;
  return (
    <svg
      className="boot-gavel"
      viewBox="0 0 80 120"
      aria-hidden
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={head.x} y={head.y} width={head.width} height={head.height} rx={head.rx} />
          <rect x={shaft.x} y={shaft.y} width={shaft.width} height={shaft.height} rx={shaft.rx} />
          <circle cx={pommel.cx} cy={pommel.cy} r={pommel.r} />
        </clipPath>
      </defs>
      <g className="gavel-shell">
        <rect x={head.x} y={head.y} width={head.width} height={head.height} rx={head.rx} />
        <rect x={shaft.x} y={shaft.y} width={shaft.width} height={shaft.height} rx={shaft.rx} />
        <circle cx={pommel.cx} cy={pommel.cy} r={pommel.r} />
      </g>
      <g clipPath={`url(#${clipId})`}>
        <rect className="fill-rise gavel-fill" x="0" y="0" width="80" height="120" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" opacity="0.92">
        <rect x={head.x} y={head.y} width={head.width} height={head.height} rx={head.rx} />
        <rect x={shaft.x} y={shaft.y} width={shaft.width} height={shaft.height} rx={shaft.rx} />
        <circle cx={pommel.cx} cy={pommel.cy} r={pommel.r} />
      </g>
      <g className="gavel-detail" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" opacity="0.4">
        {GAVEL_BANDS.map((b) => (
          <line key={`${b.x1}-${b.x2}`} x1={b.x1} y1={b.y1} x2={b.x2} y2={b.y2} />
        ))}
      </g>
    </svg>
  );
}

export function BootSplash({ message, compact = false, quiet = false }: Props) {
  const { t } = useI18n();
  const uid = useId().replace(/:/g, "");
  const clipId = `gavel-clip-${uid}`;
  const text = message ?? t("boot.loading");

  return (
    <div
      className={`boot-splash${compact ? " is-compact" : ""}${quiet ? " is-quiet" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {!quiet ? <p className="boot-brand">{t("brand.name")}</p> : null}
      <GavelMark clipId={clipId} />
      <p className="boot-msg">{text}</p>
    </div>
  );
}
