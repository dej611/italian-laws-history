export type AgentFrame = {
  duration: number;
  images?: [number, number][];
  sound?: string;
  exitBranch?: number;
  branching?: { branches: Array<{ weight: number; frameIndex: number }> };
};

export type AgentAnimation = {
  frames: AgentFrame[];
  useExitBranching?: boolean;
};

export type AgentData = {
  overlayCount: number;
  framesize: [number, number];
  sounds: string[];
  animations: Record<string, AgentAnimation>;
};

const States = { WAITING: 1, EXITED: 0 } as const;

/** Frame-by-frame CSS sprite animator (sprite-frame compatible). */
export class Animator {
  static States = States;

  private _el: HTMLElement;
  private _data: AgentData;
  private _mapUrl: string;
  private _currentFrameIndex = 0;
  private _currentFrame: AgentFrame | undefined;
  private _exiting = false;
  private _currentAnimation: AgentAnimation | undefined;
  private _endCallback: ((name: string, state: number) => void) | undefined;
  private _started = false;
  private _overlays: HTMLElement[] = [];
  private _loop: number | undefined;
  currentAnimationName: string | undefined;

  constructor(el: HTMLElement, mapUrl: string, data: AgentData) {
    this._el = el;
    this._data = data;
    this._mapUrl = mapUrl;
    this._overlays = [this._el];
    this._setupElement(this._el);
    let curr = this._el;
    for (let i = 1; i < this._data.overlayCount; i++) {
      const inner = this._setupElement(document.createElement("div"));
      curr.appendChild(inner);
      this._overlays.push(inner);
      curr = inner;
    }
  }

  private _setupElement(el: HTMLElement) {
    const [w, h] = this._data.framesize;
    el.style.display = "block";
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.background = `url("${this._mapUrl}") no-repeat`;
    el.style.backgroundPosition = "0 0";
    el.style.backgroundSize = "auto";
    return el;
  }

  animations() {
    return Object.keys(this._data.animations);
  }

  hasAnimation(name: string) {
    return !!this._data.animations[name];
  }

  exitAnimation() {
    this._exiting = true;
  }

  showAnimation(
    animationName: string,
    stateChangeCallback?: (name: string, state: number) => void,
  ) {
    this._exiting = false;
    if (!this.hasAnimation(animationName)) return false;
    this._currentAnimation = this._data.animations[animationName];
    this.currentAnimationName = animationName;
    if (!this._started) {
      this._step();
      this._started = true;
    }
    this._currentFrameIndex = 0;
    this._currentFrame = undefined;
    this._endCallback = stateChangeCallback;
    return true;
  }

  private _draw() {
    const images = this._currentFrame?.images || [];
    for (let i = 0; i < this._overlays.length; i++) {
      if (i < images.length) {
        const [x, y] = images[i];
        this._overlays[i].style.backgroundPosition = `-${x}px -${y}px`;
        this._overlays[i].style.display = "block";
      } else {
        this._overlays[i].style.display = "none";
      }
    }
  }

  private _getNextAnimationFrame(): number | undefined {
    if (!this._currentAnimation) return undefined;
    if (!this._currentFrame) return 0;
    const currentFrame = this._currentFrame;
    if (this._exiting && currentFrame.exitBranch !== undefined) {
      return currentFrame.exitBranch;
    }
    if (currentFrame.branching) {
      let rnd = Math.random() * 100;
      for (const branch of currentFrame.branching.branches) {
        if (rnd <= branch.weight) return branch.frameIndex;
        rnd -= branch.weight;
      }
    }
    return this._currentFrameIndex + 1;
  }

  private _atLastFrame() {
    return (
      !!this._currentAnimation &&
      this._currentFrameIndex >= this._currentAnimation.frames.length - 1
    );
  }

  private _step = () => {
    if (!this._currentAnimation) return;
    const newFrameIndex = Math.min(
      this._getNextAnimationFrame() ?? 0,
      this._currentAnimation.frames.length - 1,
    );
    const frameChanged =
      !this._currentFrame || this._currentFrameIndex !== newFrameIndex;
    this._currentFrameIndex = newFrameIndex;

    if (!(this._atLastFrame() && this._currentAnimation.useExitBranching)) {
      this._currentFrame = this._currentAnimation.frames[this._currentFrameIndex];
    }

    this._draw();
    this._loop = window.setTimeout(
      this._step,
      this._currentFrame?.duration ?? 100,
    );

    if (this._endCallback && frameChanged && this._atLastFrame()) {
      if (this._currentAnimation.useExitBranching && !this._exiting) {
        this._endCallback(this.currentAnimationName!, States.WAITING);
      } else {
        this._endCallback(this.currentAnimationName!, States.EXITED);
      }
    }
  };

  pause() {
    if (this._loop != null) window.clearTimeout(this._loop);
  }

  resume() {
    this._step();
  }

  dispose() {
    if (this._loop != null) window.clearTimeout(this._loop);
    this._currentAnimation = undefined;
    this._currentFrame = undefined;
    this._endCallback = undefined;
    this._started = false;
  }
}
