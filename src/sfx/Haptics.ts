import { isNative, nativeImpact, nativeNotify } from '../native';

/**
 * Touch feedback.
 *
 * In the installed app this goes through the phone's own haptic engine —
 * short, crisp taps graded light/medium/heavy — which is a different class of
 * feedback from the Vibration API's buzz, and on Android 9 WebViews the
 * Vibration API is often ignored outright. On the web it falls back to
 * navigator.vibrate, and silently does nothing where neither exists (iOS
 * Safari).
 */
export class Haptics {
  private supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

  /** Vibration used to be unconditional, which left the players who dislike it
   *  no way out except muting a different sense entirely. */
  enabled = true;

  /** Haptic feedback has a minimum useful spacing; a 12-cell wave firing 12
   *  taps in one frame just blurs into one long buzz and drains battery. */
  private lastAt = 0;

  /** False where the device has no vibration motor at all, so the settings
   *  sheet can say so rather than offering a switch that does nothing. */
  get available() {
    return this.supported || isNative;
  }

  private gate(minGapMs: number): boolean {
    if (!this.enabled) return false;
    const now = performance.now();
    if (now - this.lastAt < minGapMs) return false;
    this.lastAt = now;
    return true;
  }

  private vibrate(pattern: number | number[]) {
    if (!this.supported) return;
    // Browsers refuse vibration until the page has had a real tap, and log
    // every refusal as a console error. The computer's opening move can
    // arrive before that, so ask first rather than be refused.
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (activation && !activation.hasBeenActive) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      // ignore — some browsers throw if called outside a user gesture
    }
  }

  private impact(strength: 'light' | 'medium' | 'heavy', fallback: number | number[], minGapMs = 30) {
    if (!this.gate(minGapMs)) return;
    if (!nativeImpact(strength)) this.vibrate(fallback);
  }

  /** Subtle tick when an orb is placed. */
  place() {
    this.impact('light', 18);
  }

  /** One hit per explosion wave. Deeper waves hit harder so a long chain
   *  builds rather than drones. */
  explode(depth = 0) {
    this.impact(depth >= 6 ? 'heavy' : depth >= 2 ? 'medium' : 'light', Math.min(60, 26 + depth * 5), 45);
  }

  /** A chain crossed a milestone. */
  combo() {
    if (!this.enabled) return;
    this.lastAt = performance.now();
    if (!nativeNotify('success')) this.vibrate([30, 40, 60]);
  }

  /** A player is knocked out. */
  eliminate() {
    if (!this.enabled) return;
    this.lastAt = performance.now();
    if (!nativeNotify('warning')) this.vibrate([45, 50, 55]);
  }

  /** Game-winning celebration pattern. */
  win() {
    if (!this.enabled) return;
    this.lastAt = performance.now();
    if (!nativeNotify('success')) this.vibrate([50, 70, 50, 70, 120]);
  }

  /** UI press. Very light — it confirms the touch, nothing more. */
  tap() {
    this.impact('light', 8, 60);
  }
}

export const haptics = new Haptics();
