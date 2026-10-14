export type ChartPhase =
  | "volume"
  | "types"
  | "eras"
  | "republic"
  | "refs"
  | "taglio"
  | "channels"
  | "close";

export type ScrollyStep = {
  id: string;
  headline: string;
  body: string[];
  phase: ChartPhase;
};

/** Step ids in narrative order (copy lives in i18n catalogs). */
export const SCROLLY_STEP_IDS = [
  "archivio",
  "volume",
  "tipi",
  "regi",
  "epoche",
  "repubblica",
  "urgenze",
  "legami",
  "rete",
  "taglio",
  "memoria",
  "canali",
  "close",
] as const;
