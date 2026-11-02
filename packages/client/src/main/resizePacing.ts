/**
 * Paces an edge drag on the shaped (LCARS) window. The window is moved one step at a time: the next size is only
 * applied once the page has drawn the frame at the size before it. Without this, a fast drag moves the window ahead of
 * the page, so the frame stretches, bounces or is squashed while the page catches up.
 */
export class ResizePacer {
  private waiting = false;
  private sentAt = 0;

  /** `patience` (ms) is the longest a step waits for the page; past it the drag goes on, so it never stalls. */
  constructor(private readonly patience = 100) {}

  /** Whether a new size may be applied at `now`. */
  ready(now: number): boolean {
    return !this.waiting || now - this.sentAt >= this.patience;
  }

  /** A new size was applied at `now`; wait for the page to confirm it. */
  sent(now: number): void {
    this.waiting = true;
    this.sentAt = now;
  }

  /** The page has drawn the last size. */
  acked(): void {
    this.waiting = false;
  }
}
