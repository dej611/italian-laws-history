import { formatNumber, useI18n } from "../i18n";
import "./Hero.css";

type Props = {
  asOf: string;
  totals: { acts: number; commits: number; requests: number };
};

export function Hero({ asOf, totals }: Props) {
  const { t, locale } = useI18n();
  return (
    <header className="hero">
      <p className="hero-brand">{t("brand.name")}</p>
      <h1 className="hero-title">{t("hero.title")}</h1>
      <p className="hero-lede">
        {t("hero.lede", { count: formatNumber(totals.acts, locale) })}
      </p>
      <p className="hero-asof">{t("hero.asOf", { asOf })}</p>
      <div className="hero-scroll" aria-hidden>
        <span />
      </div>
    </header>
  );
}
