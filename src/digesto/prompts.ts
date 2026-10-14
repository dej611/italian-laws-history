import { t } from "../i18n";

export function systemPrompt() {
  return t("digesto.systemPrompt");
}

export function privacyLine() {
  return t("digesto.privacy");
}

export function disclaimerLine() {
  return t("digesto.disclaimer");
}

/** Selectable wllama GGUF models (must stay under ~2GB for browser ArrayBuffer). */
export type WllamaModelId = "qwen" | "nesso" | "emma";

export type WllamaModelSpec = {
  id: WllamaModelId;
  repo: string;
  file: string;
  /** Short display name (proper nouns stay untranslated). */
  label: string;
  /** Approximate download size in MB (for the choice UI). */
  sizeMb: number;
};

/**
 * Browser WASM catalog.
 * - Qwen3 0.6B: Safari-proven via wllama compat
 * - Nesso 0.4B Instruct: mii-llm Italian/English SLM (Nesso-4B GGUF is >2GB — not usable in-browser)
 * - Emma-5 Q8: community GGUF of egomnia/emma-5 (official release is ONNX-only)
 */
export const WLLAMA_MODELS: Record<WllamaModelId, WllamaModelSpec> = {
  qwen: {
    id: "qwen",
    repo: "bartowski/Qwen_Qwen3-0.6B-GGUF",
    file: "Qwen_Qwen3-0.6B-Q4_K_M.gguf",
    label: "Qwen3 0.6B",
    sizeMb: 484,
  },
  nesso: {
    id: "nesso",
    repo: "harrier77/nesso-0.4B-Q6_K.gguf",
    file: "nesso-0.4B-Q6_K.gguf",
    label: "Nesso 0.4B Instruct",
    sizeMb: 585,
  },
  emma: {
    id: "emma",
    repo: "MrMeOrYou/emma-5-GGUF",
    file: "emma-5-Q8_0.gguf",
    label: "Emma-5 Q8",
    sizeMb: 654,
  },
};

export const WLLAMA_MODEL_IDS = Object.keys(WLLAMA_MODELS) as WllamaModelId[];
