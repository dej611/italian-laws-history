import { Animator, type AgentData } from "./animator";
import { Balloon } from "./balloon";
import { Queue } from "./queue";
import { LOCALE_EVENT, t } from "../../i18n";
import type { DigestoChart } from "../chart";

export type AgentLoaders = {
  agent: () => Promise<{ default: AgentData }>;
  map: () => Promise<{ default: string }>;
};

type SpeakOptions = {
  holdMs?: number;
  footerHtml?: string;
  question?: string;
  chart?: DigestoChart;
};

type AgentClickHandler = () => void;

/** Digesto agent controller. */
export class Agent {
  private _queue = new Queue(() => this._onQueueEmpty());
  private _el: HTMLElement;
  private _animator: Animator;
  private _balloon: Balloon;
  private _hidden = true;
  private _idleTimer: number | undefined;
  private _onClick: AgentClickHandler | null = null;
  private _onLocale = () => {
    this._el.setAttribute("aria-label", t("digesto.agentAria"));
  };

  constructor(
    host: HTMLElement,
    data: AgentData,
    mapUrl: string,
    onAsk: (text: string) => void,
    onInputActivate?: () => void,
  ) {
    this._el = document.createElement("div");
    this._el.className = "digesto-agent";
    this._el.style.position = "relative";
    this._el.style.cursor = "pointer";
    this._el.tabIndex = 0;
    this._el.setAttribute("role", "button");
    this._el.setAttribute("aria-label", t("digesto.agentAria"));
    host.appendChild(this._el);
    this._animator = new Animator(this._el, mapUrl, data);
    this._balloon = new Balloon(this._el, {
      onSubmit: onAsk,
      onInputActivate,
    });
    window.addEventListener(LOCALE_EVENT, this._onLocale);
    this._el.addEventListener("click", () => {
      if (this._onClick) {
        this._onClick();
        return;
      }
      this.openAsk(t("digesto.greeting"));
      void this.play("GetAttention");
    });
    window.addEventListener("resize", () => this._balloon.reposition());
    window.addEventListener("scroll", () => this._balloon.reposition(), true);
  }

  setOnClick(handler: AgentClickHandler | null) {
    this._onClick = handler;
  }

  setOnClose(handler: (() => void) | undefined) {
    this._balloon.setOnClose(handler);
  }

  resetChromeActivateGate() {
    this._balloon.resetActivateGate();
  }

  get element() {
    return this._el;
  }

  animations() {
    return this._animator.animations();
  }

  /** Character visible; balloon stays closed. */
  show() {
    return new Promise<void>((resolve) => {
      this._queue.enqueue((next) => {
        this._hidden = false;
        const host = this._el.parentElement;
        if (host) host.style.display = "block";
        this._balloon.hide(true);
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
          next();
        };
        if (
          !this._animator.showAnimation("Show", (_n, state) => {
            if (state === Animator.States.EXITED) finish();
          })
        ) {
          this._animator.showAnimation("Idle");
          finish();
        }
      });
    });
  }

  hide() {
    return new Promise<void>((resolve) => {
      this._queue.enqueue((next) => {
        this._balloon.hide(true);
        const done = () => {
          this._hidden = true;
          this._el.parentElement!.style.display = "none";
          resolve();
          next();
        };
        if (!this._animator.showAnimation("Hide", (_n, state) => {
          if (state === Animator.States.EXITED) done();
        })) {
          done();
        }
      });
    });
  }

  closeBalloon() {
    this._balloon.hide(true);
  }

  /** Notice bubble (no ask form) — e.g. unsupported device. */
  openNotice(text: string) {
    this._balloon.setSlim(false);
    this._balloon.hideChoices();
    this._balloon.setMessage(text, undefined, null);
    this._balloon.showInput(false);
    void this.play("GetAttention");
  }

  /** Ask bubble with input. */
  openAsk(text: string) {
    this._balloon.setSlim(false);
    this._balloon.hideChoices();
    this._balloon.setMessage(text, undefined, null);
    this._balloon.showInput(true);
    void this.play("GetAttention");
  }

  /** Model choice (no ask form). onPick runs from button pointerdown. */
  openChoices(
    text: string,
    choices: Array<{ id: string; label: string; hint?: string }>,
    onPick: (id: string) => void,
  ) {
    this._balloon.setSlim(false);
    this._balloon.showInput(false);
    this._balloon.setMessage(text, undefined, null);
    this._balloon.showChoices(choices, onPick);
    void this.play("GetAttention");
  }

  hideChoices() {
    this._balloon.hideChoices();
  }

  setSuggestions(items: string[], onPick: (text: string) => void) {
    this._balloon.setSuggestions(items, onPick);
  }

  showInput(show: boolean) {
    this._balloon.showInput(show);
  }

  play(animation: string) {
    return new Promise<void>((resolve) => {
      this._queue.enqueue((next) => {
        if (!this._animator.hasAnimation(animation)) {
          resolve();
          next();
          return;
        }
        let settled = false;
        this._animator.showAnimation(animation, (_n, state) => {
          if (settled) return;
          if (state === Animator.States.EXITED || state === Animator.States.WAITING) {
            settled = true;
            resolve();
            next();
          }
        });
      });
    });
  }

  animate(animation: string) {
    if (!this._animator.hasAnimation(animation)) return;
    this._animator.showAnimation(animation);
  }

  stop() {
    this._animator.exitAnimation();
  }

  speak(text: string, opts: SpeakOptions = {}) {
    return new Promise<void>((resolve) => {
      this._queue.enqueue((next) => {
        this._animator.exitAnimation();
        this._balloon.setSlim(false);
        void this._animator.showAnimation("Speak");
        void this._balloon
          .speak(text, {
            holdMs: opts.holdMs ?? 10000,
            footerHtml: opts.footerHtml,
            question: opts.question,
            chart: opts.chart,
          })
          .then(() => {
            resolve();
            next();
          });
      });
    });
  }

  showPending() {
    this._queue.clear();
    this._balloon.showPending();
    if (this._animator.hasAnimation("Thinking")) {
      this._animator.exitAnimation();
      this._animator.showAnimation("Thinking");
    }
  }

  speakCue(text: string, animation: string, holdMs = 6000) {
    return new Promise<void>((resolve) => {
      this._queue.enqueue((next) => {
        this._animator.exitAnimation();
        if (this._animator.hasAnimation(animation)) {
          this._animator.showAnimation(animation);
        }
        void this._balloon.speakCue(text, holdMs).then(() => {
          resolve();
          next();
        });
      });
    });
  }

  cancelCue() {
    this._queue.clear();
    this._balloon.cancelCue();
  }

  setMessage(text: string, footerHtml?: string, question?: string | null) {
    this._balloon.setMessage(text, footerHtml, question);
  }

  private _onQueueEmpty() {
    if (this._hidden) return;
    if (this._idleTimer != null) window.clearTimeout(this._idleTimer);
    this._idleTimer = window.setTimeout(() => {
      const idleAnims = ["Idle", "LookLeft", "LookRight"].filter((a) =>
        this._animator.hasAnimation(a),
      );
      if (!idleAnims.length) return;
      const pick = idleAnims[Math.floor(Math.random() * idleAnims.length)];
      void this.play(pick);
    }, 2500);
  }

  dispose() {
    window.removeEventListener(LOCALE_EVENT, this._onLocale);
    if (this._idleTimer != null) window.clearTimeout(this._idleTimer);
    this._queue.clear();
    this._animator.dispose();
    this._balloon.dispose();
    this._el.remove();
  }
}

export async function initAgent(
  loaders: AgentLoaders,
  host: HTMLElement,
  onAsk: (text: string) => void,
  onInputActivate?: () => void,
) {
  const [{ default: data }, { default: mapUrl }] = await Promise.all([
    loaders.agent(),
    loaders.map(),
  ]);
  return new Agent(host, data, mapUrl, onAsk, onInputActivate);
}
