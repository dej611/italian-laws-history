import { useI18n } from "../i18n";
import { BootSplash } from "./BootSplash";
import "./Explore.css";

export function ExploreLoading() {
  const { t } = useI18n();
  return (
    <section className="explore" id="esplora" aria-label={t("explore.ariaLabel")} aria-busy>
      <header className="explore-head">
        <h2>{t("explore.title")}</h2>
        <p>{t("explore.loadingNetwork")}</p>
      </header>
      <div className="explore-stage">
        <BootSplash compact message={t("explore.loadingGraph")} />
      </div>
    </section>
  );
}
