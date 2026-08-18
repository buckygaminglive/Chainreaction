/** Thin wrapper around the Vibration API — silently no-ops where unsupported (e.g. iOS Safari). */
export class Haptics {
  private supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

  private fire(pattern: number | number[]) {
    if (!this.supported) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      // ignore — some browsers throw if called outside a user gesture
    }
  }

  /** Subtle tick when an orb is placed. */
  place() {
    this.fire(25);
  }

  /** One buzz per explosion wave — a multi-wave cascade naturally rumbles. */
  explode() {
    this.fire(40);
  }

  /** A player is knocked out. */
  eliminate() {
    this.fire([45, 50, 55]);
  }

  /** Game-winning celebration pattern. */
  win() {
    this.fire([50, 70, 50, 70, 120]);
  }
}

export const haptics = new Haptics();
