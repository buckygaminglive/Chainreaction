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
    this.fire(12);
  }

  /** One buzz per explosion wave — a multi-wave cascade naturally rumbles. */
  explode() {
    this.fire(28);
  }

  /** A player is knocked out. */
  eliminate() {
    this.fire([30, 40, 35]);
  }

  /** Game-winning celebration pattern. */
  win() {
    this.fire([40, 60, 40, 60, 90]);
  }
}

export const haptics = new Haptics();
