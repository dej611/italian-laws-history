import { useI18n } from "../i18n";
import "./TimeBrush.css";

type Props = {
  minYear: number;
  maxYear: number;
  year: number;
  onChange: (y: number) => void;
  playing: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStep: (delta: number) => void;
  nodeCount: number;
  edgeCount: number;
};

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M8 5.5v13l11-6.5L8 5.5z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M7 5h3.5v14H7V5zm6.5 0H17v14h-3.5V5z" />
    </svg>
  );
}

/** Walkman-style rewind: bar + double triangle left. */
function IconRewind() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3.5 5h2v14h-2V5zm16.2 1.1v11.8L12.4 12l7.3-5.9zm-8.1 0v11.8L4.3 12l7.3-5.9z"
      />
    </svg>
  );
}

/** Walkman-style fast-forward: double triangle right + bar. */
function IconFastForward() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.5 5h2v14h-2V5zM4.3 6.1v11.8L11.6 12 4.3 6.1zm8.1 0v11.8L19.7 12l-7.3-5.9z"
      />
    </svg>
  );
}

export function TimeBrush({
  minYear,
  maxYear,
  year,
  onChange,
  playing,
  onPlay,
  onPause,
  onStep,
  nodeCount,
  edgeCount,
}: Props) {
  const { t } = useI18n();
  return (
    <div className="time-brush">
      <div className="time-brush-label">
        <span>{t("timeBrush.label", { year })}</span>
        <span className="time-brush-counts">
          {t("timeBrush.counts", { nodes: nodeCount, edges: edgeCount })}
        </span>
      </div>
      <input
        type="range"
        min={minYear}
        max={maxYear}
        value={year}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={t("timeBrush.ariaLabel", { year })}
      />
      <div className="time-brush-ends">
        <span>{minYear}</span>
        <span>{maxYear}</span>
      </div>
      <div className="time-brush-transport" role="group" aria-label={t("timeBrush.transportAria")}>
        <button
          type="button"
          className="time-brush-btn"
          onClick={() => onStep(-10)}
          aria-label={t("timeBrush.back10")}
          title={t("timeBrush.back10")}
        >
          <IconRewind />
        </button>
        {playing ? (
          <button
            type="button"
            className="time-brush-btn time-brush-btn-primary"
            onClick={onPause}
            aria-label={t("timeBrush.pause")}
            title={t("timeBrush.pause")}
          >
            <IconPause />
          </button>
        ) : (
          <button
            type="button"
            className="time-brush-btn time-brush-btn-primary"
            onClick={onPlay}
            aria-label={t("timeBrush.play")}
            title={t("timeBrush.play")}
          >
            <IconPlay />
          </button>
        )}
        <button
          type="button"
          className="time-brush-btn"
          onClick={() => onStep(10)}
          aria-label={t("timeBrush.forward10")}
          title={t("timeBrush.forward10")}
        >
          <IconFastForward />
        </button>
      </div>
    </div>
  );
}
