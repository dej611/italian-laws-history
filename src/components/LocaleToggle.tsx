import { useI18n, type Locale } from "../i18n";
import "./LocaleToggle.css";

const OPTIONS: Locale[] = ["it", "en"];

export function LocaleToggle() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="locale-toggle" role="group" aria-label={t("locale.ariaLabel")}>
      {OPTIONS.map((code) => (
        <button
          key={code}
          type="button"
          className={locale === code ? "is-active" : undefined}
          aria-pressed={locale === code}
          onClick={() => setLocale(code)}
        >
          {t(`locale.${code}`)}
        </button>
      ))}
    </div>
  );
}
