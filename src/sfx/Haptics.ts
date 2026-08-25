/** Thin wrapper around the Vibration API — silently no-ops where unsupported (e.g. iOS Safari). */
export class Haptics {
  private supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

  /** Vibration used to be unconditional, which left the players who dislike it
   *  no way out except muting a different sense entirely. */
  enabled = true;

  /** False where the device has no vibration motor at all, so the settings
   *  sheet can say so rather than offering a switch that does nothing. */
  get available() {
    return this.supported;
  }

  private fire(pattern: number | number[]) {
    if (!this.supported || !this.enabled) return;
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

  /** One buzz per explosion wave — a multi-wave cascade naturally rumbles.
   *  Deeper waves hit harder so a long chain builds rather than drones. */
  explode(depth = 0) {
    this.fire(Math.min(70, 34 + depth * 5));
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
