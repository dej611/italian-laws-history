import type { Root } from "react-dom/client";
import "./balloon.css";
import { LOCALE_EVENT, t } from "../../i18n";
import type { DigestoChart } from "../chart";
import { disclaimerLine, privacyLine } from "../prompts";

export type ChatTurn = {
  question: string;
  answer: string;
  footerHtml?: string;
  chart?: DigestoChart;
};

type BalloonOptions = {
  onSubmit?: (text: string) => void;
  /** Fired on pointerdown/click of the ask field (user gesture — for Chrome AI). */
  onInputActivate?: () => void;
  onClose?: () => void;
  placeholder?: string;
};

/** Speech panel with history, question+answer, close, ask input. */
export class Balloon {
  private _agentEl: HTMLElement;
  private _el: HTMLElement;
  private _shell: HTMLElement;
  private _historyEl: HTMLElement;
  private _historyList: HTMLElement;
  private _main: HTMLElement;
  private _head: HTMLElement;
  private _title: HTMLElement;
  private _close: HTMLButtonElement;
  private _histLabel: HTMLElement;
  private _questionEl: HTMLElement;
  private _content: HTMLElement;
  private _chartHost: HTMLElement;
  private _chartRoot: Root | null = null;
  private _chartGen = 0;
  private _footer: HTMLElement;
  private _legal: HTMLElement;
  private _form: HTMLFormElement | null = null;
  private _input: HTMLInputElement | null = null;
  private _submit: HTMLButtonElement | null = null;
  private _choices: HTMLDivElement | null = null;
  private _suggestions: HTMLDivElement | null = null;
  private _suggestionItems: string[] = [];
  private _onSuggestion: ((text: string) => void) | null = null;
  private _hidden = true;
  private _typeTimer: number | undefined;
  private _opts: BalloonOptions;
  private _activateFired = false;
  private _turns: ChatTurn[] = [];
  private _activeTurn = -1;
  private _slim = false;
  private _cueTimer: number | undefined;
  private _cueResolve: (() => void) | undefined;
  private _onLocale = () => this.applyLocale();

  constructor(agentEl: HTMLElement, opts: BalloonOptions = {}) {
    this._agentEl = agentEl;
    this._opts = opts;

    this._el = document.createElement("div");
    this._el.className = "digesto-balloon";
    this._el.setAttribute("role", "dialog");

    this._head = document.createElement("div");
    this._head.className = "digesto-balloon-head";
    this._title = document.createElement("span");
    this._title.className = "digesto-balloon-title";
    this._close = document.createElement("button");
    this._close.type = "button";
    this._close.className = "digesto-balloon-close";
    this._close.textContent = "×";
    this._close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hide(true);
      this._opts.onClose?.();
    });
    this._head.appendChild(this._title);
    this._head.appendChild(this._close);

    this._shell = document.createElement("div");
    this._shell.className = "digesto-balloon-shell";

    this._historyEl = document.createElement("aside");
    this._historyEl.className = "digesto-balloon-history";
    this._histLabel = document.createElement("div");
    this._histLabel.className = "digesto-balloon-history-label";
    this._historyList = document.createElement("ul");
    this._historyList.className = "digesto-balloon-history-list";
    this._historyEl.appendChild(this._histLabel);
    this._historyEl.appendChild(this._historyList);

    this._main = document.createElement("div");
    this._main.className = "digesto-balloon-main";

    this._questionEl = document.createElement("div");
    this._questionEl.className = "digesto-balloon-question";
    this._questionEl.hidden = true;

    this._content = document.createElement("div");
    this._content.className = "digesto-balloon-content";

    this._chartHost = document.createElement("div");
    this._chartHost.className = "digesto-balloon-chart";
    this._chartHost.hidden = true;

    this._footer = document.createElement("div");
    this._footer.className = "digesto-balloon-footer";

    this._legal = document.createElement("div");
    this._legal.className = "digesto-balloon-legal";

    this._main.appendChild(this._questionEl);
    this._main.appendChild(this._content);
    this._main.appendChild(this._chartHost);
    this._main.appendChild(this._footer);

    this._shell.appendChild(this._historyEl);
    this._shell.appendChild(this._main);

    this._el.appendChild(this._head);
    this._el.appendChild(this._shell);
    this._el.appendChild(this._legal);
    document.body.appendChild(this._el);
    this._buildForm();
    this._buildChoices();
    this._buildSuggestions();
    this.applyLocale();
    this._syncHistoryVisibility();
    this.hide(true);
    window.addEventListener(LOCALE_EVENT, this._onLocale);
  }

  private _reveal() {
    this._hidden = false;
    this._el.style.display = "block";
    this.reposition();
  }

  applyLocale() {
    this._el.setAttribute("aria-label", t("digesto.name"));
    this._title.textContent = t("digesto.name");
    this._close.setAttribute("aria-label", t("common.close"));
    this._histLabel.textContent = t("digesto.historyLabel");
    this._legal.innerHTML = `<p>${privacyLine()}</p><p>${disclaimerLine()}</p>`;
    if (this._input) {
      this._input.placeholder = this._opts.placeholder ?? t("digesto.placeholder");
    }
    if (this._submit) this._submit.textContent = t("digesto.submit");
  }

  private _emitActivate = () => {
    if (this._activateFired) return;
    this._activateFired = true;
    this._opts.onInputActivate?.();
  };

  setOnClose(handler: (() => void) | undefined) {
    this._opts.onClose = handler;
  }

  resetActivateGate() {
    this._activateFired = false;
  }

  setSlim(slim: boolean) {
    this._slim = slim;
    this._el.classList.toggle("digesto-balloon--slim", slim);
    this._historyEl.hidden = slim || this._turns.length === 0;
    this._legal.hidden = slim;
    this._head.hidden = slim;
    if (slim) {
      this.showInput(false);
      this._syncSuggestions();
    }
    this.reposition();
  }

  private _buildForm() {
    this._form = document.createElement("form");
    this._form.className = "digesto-balloon-form";
    this._form.style.display = "none";
    this._input = document.createElement("input");
    this._input.type = "text";
    this._input.autocomplete = "off";
    this._input.addEventListener("pointerdown", this._emitActivate);
    this._input.addEventListener("click", this._emitActivate);
    this._submit = document.createElement("button");
    this._submit.type = "submit";
    this._form.appendChild(this._input);
    this._form.appendChild(this._submit);
    this._form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = this._input?.value.trim() ?? "";
      if (!text) return;
      this._input!.value = "";
      this._opts.onSubmit?.(text);
    });
    this._el.insertBefore(this._form, this._legal);
  }

  private _buildChoices() {
    this._choices = document.createElement("div");
    this._choices.className = "digesto-balloon-choices";
    this._choices.hidden = true;
    this._el.insertBefore(this._choices, this._legal);
  }

  private _buildSuggestions() {
    this._suggestions = document.createElement("div");
    this._suggestions.className = "digesto-balloon-suggestions";
    this._suggestions.hidden = true;
    this._el.insertBefore(this._suggestions, this._legal);
  }

  setSuggestions(items: string[], onPick: (text: string) => void) {
    this._suggestionItems = items;
    this._onSuggestion = onPick;
    this._syncSuggestions();
  }

  private _syncSuggestions() {
    if (!this._suggestions) return;
    this._suggestions.replaceChildren();
    const inputShown = this._form?.style.display !== "none";
    const show = inputShown && this._suggestionItems.length > 0;
    for (const text of this._suggestionItems) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "digesto-balloon-suggestion";
      btn.textContent = text;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._onSuggestion?.(text);
      });
      this._suggestions.appendChild(btn);
    }
    this._suggestions.hidden = !show;
    if (show) this.reposition();
  }

  /** Show model-pick buttons. onPick is called from pointerdown (user gesture). */
  showChoices(
    choices: Array<{ id: string; label: string; hint?: string }>,
    onPick: (id: string) => void,
  ) {
    if (!this._choices) return;
    this._choices.replaceChildren();
    for (const c of choices) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "digesto-balloon-choice";
      btn.dataset.choiceId = c.id;
      const title = document.createElement("span");
      title.className = "digesto-balloon-choice-title";
      title.textContent = c.label;
      btn.appendChild(title);
      if (c.hint) {
        const hint = document.createElement("span");
        hint.className = "digesto-balloon-choice-hint";
        hint.textContent = c.hint;
        btn.appendChild(hint);
      }
      const pick = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.dataset.picked === "1") return;
        btn.dataset.picked = "1";
        onPick(c.id);
      };
      // pointerdown keeps native LanguageModel.create() inside the user gesture
      btn.addEventListener("pointerdown", pick);
      btn.addEventListener("click", pick);
      this._choices.appendChild(btn);
    }
    this._choices.hidden = false;
    this._reveal();
    this.reposition();
  }

  hideChoices() {
    if (!this._choices) return;
    this._choices.hidden = true;
    this._choices.replaceChildren();
  }

  private _syncHistoryVisibility() {
    this._historyEl.hidden = this._turns.length === 0;
    this._el.classList.toggle("digesto-balloon--with-history", this._turns.length > 0);
  }

  private _renderHistory() {
    this._historyList.replaceChildren();
    this._turns.forEach((turn, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "digesto-balloon-history-item";
      if (i === this._activeTurn) btn.classList.add("is-active");
      btn.textContent = turn.question;
      btn.title = turn.question;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showTurn(i);
      });
      li.appendChild(btn);
      this._historyList.appendChild(li);
    });
    this._syncHistoryVisibility();
  }

  showTurn(index: number) {
    const turn = this._turns[index];
    if (!turn) return;
    this._activeTurn = index;
    this._renderHistory();
    this._reveal();
    if (this._typeTimer != null) window.clearInterval(this._typeTimer);
    this._setQuestion(turn.question);
    this._content.textContent = turn.answer;
    this._footer.innerHTML = turn.footerHtml ?? "";
    void this._setChart(turn.chart);
    this.showInput(true);
    this.reposition();
  }

  addTurn(turn: ChatTurn) {
    this._turns.push(turn);
    this._activeTurn = this._turns.length - 1;
    this._renderHistory();
  }

  private _setQuestion(question: string | null) {
    if (question) {
      this._questionEl.hidden = false;
      this._questionEl.textContent = question;
    } else {
      this._questionEl.hidden = true;
      this._questionEl.textContent = "";
    }
  }

  private async _setChart(chart: DigestoChart | undefined) {
    const gen = ++this._chartGen;
    if (this._chartRoot) {
      this._chartRoot.unmount();
      this._chartRoot = null;
    }
    this._chartHost.replaceChildren();
    if (!chart) {
      this._chartHost.hidden = true;
      this.reposition();
      return;
    }
    this._chartHost.hidden = false;
    const [{ createRoot }, { createElement }, { DigestoChartView }] = await Promise.all([
      import("react-dom/client"),
      import("react"),
      import("../DigestoChart"),
    ]);
    if (gen !== this._chartGen) return;
    this._chartRoot = createRoot(this._chartHost);
    this._chartRoot.render(createElement(DigestoChartView, { chart }));
    requestAnimationFrame(() => this.reposition());
  }

  setMessage(text: string, footerHtml?: string, question?: string | null) {
    this._reveal();
    if (this._typeTimer != null) window.clearInterval(this._typeTimer);
    this._setQuestion(question ?? null);
    this._content.textContent = text;
    this._footer.innerHTML = footerHtml ?? "";
    void this._setChart(undefined);
    this.reposition();
  }

  showInput(show: boolean) {
    if (!this._form) return;
    this._form.style.display = show ? "flex" : "none";
    if (show) {
      this.hideChoices();
      this._reveal();
    }
    this._syncSuggestions();
  }

  speak(
    text: string,
    opts: {
      holdMs?: number;
      footerHtml?: string;
      question?: string;
      chart?: DigestoChart;
    } = {},
  ) {
    return new Promise<void>((resolve) => {
      this._reveal();
      this.showInput(false);
      if (this._typeTimer != null) window.clearInterval(this._typeTimer);
      this._setQuestion(opts.question ?? null);
      this._content.textContent = "";
      this._footer.innerHTML = opts.footerHtml ?? "";
      void this._setChart(undefined);
      let i = 0;
      this._typeTimer = window.setInterval(() => {
        i += 1;
        this._content.textContent = text.slice(0, i);
        this.reposition();
        if (i >= text.length) {
          if (this._typeTimer != null) window.clearInterval(this._typeTimer);
          void this._setChart(opts.chart).then(() => {
            if (opts.question) {
              this.addTurn({
                question: opts.question,
                answer: text,
                footerHtml: opts.footerHtml,
                chart: opts.chart,
              });
            }
            this.showInput(true);
            resolve();
          });
        }
      }, 18);
    });
  }

  showPending() {
    this._finishCue();
    this.setSlim(true);
    this.hideChoices();
    this.showInput(false);
    this._reveal();
    if (this._typeTimer != null) window.clearInterval(this._typeTimer);
    this._setQuestion(null);
    this._footer.innerHTML = "";
    void this._setChart(undefined);
    this._content.classList.add("is-pending");
    this._content.setAttribute("aria-busy", "true");
    this._content.setAttribute("aria-label", t("chart.whisperPending"));
    const dots = document.createElement("span");
    dots.className = "digesto-cue-dots";
    dots.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("i"));
    this._content.replaceChildren(dots);
    this.reposition();
  }

  speakCue(text: string, holdMs = 6000) {
    return new Promise<void>((resolve) => {
      this._finishCue();
      this._cueResolve = resolve;
      this.setSlim(true);
      this.hideChoices();
      this.showInput(false);
      this._reveal();
      if (this._typeTimer != null) window.clearInterval(this._typeTimer);
      this._setQuestion(null);
      this._clearPending();
      this._content.textContent = text;
      this._footer.innerHTML = "";
      void this._setChart(undefined);
      this.reposition();
      this._cueTimer = window.setTimeout(() => {
        this.hide(true);
        this.setSlim(false);
        this._finishCue();
      }, holdMs);
    });
  }

  cancelCue() {
    if (this._slim) {
      this.hide(true);
      this.setSlim(false);
    }
    this._clearPending();
    this._finishCue();
  }

  private _clearPending() {
    this._content.classList.remove("is-pending");
    this._content.removeAttribute("aria-busy");
    this._content.removeAttribute("aria-label");
  }

  private _finishCue() {
    if (this._cueTimer != null) window.clearTimeout(this._cueTimer);
    this._cueTimer = undefined;
    const r = this._cueResolve;
    this._cueResolve = undefined;
    r?.();
  }

  hide(immediate = false) {
    this._hidden = true;
    if (this._typeTimer != null) window.clearInterval(this._typeTimer);
    this.hideChoices();
    if (this._suggestions) this._suggestions.hidden = true;
    this._el.style.display = "none";
    this._finishCue();
    void immediate;
  }

  reposition() {
    if (this._hidden) return;
    const rect = this._agentEl.getBoundingClientRect();
    const bw = this._el.offsetWidth || 360;
    const bh = this._el.offsetHeight || 160;
    let left = rect.left - bw - 12;
    let top = rect.bottom - bh;
    if (left < 8) left = Math.max(8, rect.left + rect.width / 2 - bw / 2);
    top = Math.max(8, Math.min(top, window.innerHeight - bh - 8));
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    if (top + bh > window.innerHeight - 8) top = Math.max(8, rect.top - bh - 12);
    this._el.style.left = `${left}px`;
    this._el.style.top = `${top}px`;
  }

  dispose() {
    window.removeEventListener(LOCALE_EVENT, this._onLocale);
    if (this._typeTimer != null) window.clearInterval(this._typeTimer);
    this._finishCue();
    if (this._chartRoot) {
      this._chartRoot.unmount();
      this._chartRoot = null;
    }
    this._el.remove();
  }
}
