import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  applyTheme,
  readThemePref,
  resolveTheme,
  systemPrefersDark,
  THEME_EVENT,
  type ResolvedTheme,
  type ThemePref,
} from "../theme";
import "./ThemeToggle.css";

export function ThemeToggle() {
  const { t } = useI18n();
  const [pref, setPref] = useState<ThemePref>(() => readThemePref());
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readThemePref()),
  );

  const OPTIONS: { value: ThemePref; label: string }[] = [
    { value: "system", label: t("theme.system") },
    { value: "light", label: t("theme.light") },
    { value: "dark", label: t("theme.dark") },
  ];

  useEffect(() => {
    applyTheme(pref);
  }, [pref]);

  useEffect(() => {
    const onTheme = (e: Event) => {
      const detail = (e as CustomEvent<{ pref: ThemePref; resolved: ResolvedTheme }>)
        .detail;
      if (!detail) return;
      setResolved(detail.resolved);
    };
    window.addEventListener(THEME_EVENT, onTheme);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => {
      if (readThemePref() === "system") applyTheme("system");
    };
    mq.addEventListener("change", onSystem);
    return () => {
      window.removeEventListener(THEME_EVENT, onTheme);
      mq.removeEventListener("change", onSystem);
    };
  }, []);

  const currentTitle =
    pref === "system"
      ? `${t("theme.systemTitle")} (${systemPrefersDark() ? t("theme.dark") : t("theme.light")})`
      : pref === "dark"
        ? t("theme.darkTitle")
        : t("theme.lightTitle");

  return (
    <div className="theme-toggle" data-resolved={resolved}>
      <label className="sr-only" htmlFor="theme-pref">
        {t("theme.ariaLabel")}
      </label>
      <select
        id="theme-pref"
        value={pref}
        title={currentTitle}
        aria-label={t("theme.ariaLabel")}
        onChange={(e) => setPref(e.target.value as ThemePref)}
      >
        {OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
