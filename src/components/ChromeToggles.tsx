import { LocaleToggle } from "./LocaleToggle";
import { ThemeToggle } from "./ThemeToggle";
import { useI18n } from "../i18n";
import "./ChromeToggles.css";

type Props = {
  onSouvenir?: () => void;
};

export function ChromeToggles({ onSouvenir }: Props) {
  const { t } = useI18n();
  return (
    <div className="chrome-toggles">
      {onSouvenir ? (
        <button type="button" className="souvenir-toggle" onClick={onSouvenir}>
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
            <circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="10" cy="10" r="5.6" fill="none" stroke="currentColor" strokeWidth="1" />
            <text
              x="10"
              y="13"
              textAnchor="middle"
              fontSize="8"
              fontFamily="Georgia, Palatino, serif"
              fill="currentColor"
            >
              N
            </text>
          </svg>
          <span>{t("gazzetta.souvenir")}</span>
        </button>
      ) : null}
      <LocaleToggle />
      <ThemeToggle />
    </div>
  );
}
