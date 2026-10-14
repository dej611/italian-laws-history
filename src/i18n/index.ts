import { useEffect, useMemo, useState } from "react";
import { en } from "./en";
import { it } from "./it";
import type { Locale, Messages, StepCopy } from "./types";
import type { ChartPhase, ScrollyStep } from "../content/steps";

export type { Locale, Messages, StepCopy };

export const LOCALE_STORAGE_KEY = "normoscopio-locale";
export const LOCALE_EVENT = "normoscopio:locale";

const catalogs: Record<Locale, Messages> = { it, en };

const STEP_PHASE: Record<string, ChartPhase> = {
  archivio: "volume",
  volume: "volume",
  tipi: "types",
  regi: "types",
  epoche: "eras",
  repubblica: "republic",
  urgenze: "republic",
  legami: "refs",
  rete: "refs",
  taglio: "taglio",
  memoria: "taglio",
  canali: "channels",
  close: "channels",
};

const STEP_ORDER = Object.keys(STEP_PHASE);

const stepsCache: Partial<Record<Locale, ScrollyStep[]>> = {};

function detectBrowserLocale(): Locale {
  try {
    const nav = (navigator.language || "").toLowerCase();
    if (nav.startsWith("en")) return "en";
  } catch {
    /* ignore */
  }
  return "it";
}

export function readLocale(): Locale {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (v === "it" || v === "en") return v;
  } catch {
    /* ignore */
  }
  return detectBrowserLocale();
}

let current: Locale = "it";

export function getLocale(): Locale {
  return current;
}

export function messages(locale: Locale = current): Messages {
  return catalogs[locale] ?? catalogs.it;
}

function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    vars[key] != null ? String(vars[key]) : `{${key}}`,
  );
}

/** Nested path lookup with Italian fallback. */
export function t(
  path: string,
  vars?: Record<string, string | number>,
  locale: Locale = current,
): string {
  const pick = (loc: Locale): unknown => {
    const parts = path.split(".");
    let cur: unknown = catalogs[loc];
    for (const p of parts) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  };
  const raw = pick(locale);
  const fallback = locale === "it" ? undefined : pick("it");
  const value = typeof raw === "string" ? raw : typeof fallback === "string" ? fallback : path;
  return fill(value, vars);
}

export function getSteps(locale: Locale = current): ScrollyStep[] {
  const cached = stepsCache[locale];
  if (cached) return cached;
  const pack = messages(locale).steps;
  const itPack = catalogs.it.steps;
  const built = STEP_ORDER.map((id) => {
    const copy: StepCopy = pack[id] ?? itPack[id];
    return {
      id,
      phase: STEP_PHASE[id],
      headline: copy.headline,
      body: copy.body,
    };
  });
  stepsCache[locale] = built;
  return built;
}

export function applyLocale(locale: Locale) {
  current = locale;
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: { locale } }));
}

export function initLocale() {
  applyLocale(readLocale());
}

export function useI18n() {
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ locale: Locale }>).detail;
      if (detail?.locale) setLocaleState(detail.locale);
    };
    window.addEventListener(LOCALE_EVENT, onChange);
    return () => window.removeEventListener(LOCALE_EVENT, onChange);
  }, []);

  const steps = useMemo(() => getSteps(locale), [locale]);
  const m = useMemo(() => messages(locale), [locale]);

  return {
    locale,
    t: (path: string, vars?: Record<string, string | number>) => t(path, vars, locale),
    steps,
    m,
    setLocale: applyLocale,
  };
}

export function formatNumber(n: number, locale: Locale = current): string {
  return new Intl.NumberFormat(locale === "en" ? "en-GB" : "it-IT").format(n);
}
