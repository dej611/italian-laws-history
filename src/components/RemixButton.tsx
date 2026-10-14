import { t } from "../i18n";
import "./RemixButton.css";

type Props = {
  onClick: () => void;
};

export function RemixButton({ onClick }: Props) {
  return (
    <button
      type="button"
      className="remix-icon-btn"
      onClick={onClick}
      aria-label={t("explore.remixAria")}
      title={t("explore.remixAria")}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 7h4.5L16 17H20M20 7h-4L8.5 17H4M17.5 4.5L20 7l-2.5 2.5M17.5 14.5L20 17l-2.5 2.5"
        />
      </svg>
    </button>
  );
}
