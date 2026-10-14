export type QueueFn = (next: () => void) => void;

/** Sequential action queue (sprite-queue compatible). */
export class Queue {
  private _queue: QueueFn[] = [];
  private _active = false;
  private _onEmpty?: () => void;

  constructor(onEmpty?: () => void) {
    this._onEmpty = onEmpty;
  }

  enqueue(fn: QueueFn) {
    this._queue.push(fn);
    if (!this._active) this._next();
  }

  clear() {
    this._queue = [];
    this._active = false;
  }

  private _next = () => {
    this._active = false;
    const fn = this._queue.shift();
    if (!fn) {
      this._onEmpty?.();
      return;
    }
    this._active = true;
    fn(this._next);
  };
}
