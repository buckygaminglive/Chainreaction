/**
 * Everything that differs between the installed Android app and the website.
 *
 * The app is the same web build, copied into the APK and run from the phone's
 * own storage by Capacitor — so almost nothing differs, and what does is kept
 * in this one file rather than sprinkled through main.ts as platform checks.
 * Every export works on the web too, degrading to the nearest browser
 * equivalent, so callers never branch on the platform themselves.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Share } from '@capacitor/share';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

export const isNative = Capacitor.isNativePlatform();

/** Where shared links point. In the app `location.origin` is
 *  https://localhost, which means nothing on anyone else's phone. */
export const PUBLIC_ORIGIN = 'https://chainreaction-sooty.vercel.app';

/** A link that opens a room: in the app where it is installed (Android App
 *  Links claim /join), and in the browser everywhere else. */
export function roomLink(code: string): string {
  return `${PUBLIC_ORIGIN}/join?room=${encodeURIComponent(code)}`;
}

/** Pulls a room code out of anything that can arrive as a link: the https
 *  invite, the old ?room= form, or fissile://room/CODE. */
export function roomCodeFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const q = url.searchParams.get('room');
    if (q) return q.toUpperCase();
    if (url.protocol === 'fissile:') {
      const parts = `${url.host}${url.pathname}`.split('/').filter(Boolean);
      if (parts[0] === 'room' && parts[1]) return parts[1].toUpperCase();
    }
  } catch {
    /* not a URL */
  }
  return null;
}

// ---------- Share ----------

export type ShareOutcome = 'shared' | 'copied' | 'failed';

/**
 * Opens the system share sheet — WhatsApp, Instagram, Telegram, whatever the
 * phone has — or copies to the clipboard where there is no sheet.
 *
 * This is the game's whole growth loop: one student sending a room link or a
 * chain screenshot to a group chat. It is worth the share sheet over a copy
 * button, because a copy button makes the player do the remaining four steps.
 */
export async function share(opts: { title: string; text: string; url?: string }): Promise<ShareOutcome> {
  const { title, text, url } = opts;
  try {
    if (isNative) {
      await Share.share({ title, text, url, dialogTitle: title });
      return 'shared';
    }
    if (typeof navigator.share === 'function') {
      await navigator.share({ title, text, url });
      return 'shared';
    }
  } catch (err) {
    // Dismissing the sheet rejects with AbortError. That is the player
    // changing their mind, not a failure worth a fallback.
    if (err instanceof Error && /abort|cancel/i.test(`${err.name} ${err.message}`)) return 'failed';
  }
  try {
    await navigator.clipboard.writeText(url ? `${text}\n${url}` : text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

// ---------- Haptics ----------

/** Native haptics where available. On a phone the system haptic engine is a
 *  different class of feedback from navigator.vibrate — crisp, short taps
 *  instead of a buzz — and on Android 9 WebViews vibrate() is often silently
 *  ignored altogether. Returns false when the caller should fall back. */
export function nativeImpact(strength: 'light' | 'medium' | 'heavy'): boolean {
  if (!isNative) return false;
  const style = strength === 'heavy' ? ImpactStyle.Heavy : strength === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light;
  void Haptics.impact({ style }).catch(() => {});
  return true;
}

export function nativeNotify(kind: 'success' | 'warning' | 'error'): boolean {
  if (!isNative) return false;
  const type =
    kind === 'success' ? NotificationType.Success : kind === 'warning' ? NotificationType.Warning : NotificationType.Error;
  void Haptics.notification({ type }).catch(() => {});
  return true;
}

// ---------- Back button ----------

/**
 * Android's back button, as a stack of handlers.
 *
 * Each open layer — a sheet, a screen, a match — pushes a handler and pops it
 * when it closes, so back always undoes the most recent thing. With nothing
 * left to undo the app goes to the background rather than exiting: that is
 * what back does on a launcher-level screen in every Android game, and it
 * keeps the process (and a resumable match) alive.
 */
type BackHandler = () => boolean;
let backResolver: BackHandler = () => false;

/** Installs the one function that decides what back does. main.ts owns the
 *  screen state, so it answers; this file only wires the button to it. */
export function onBackButton(handler: BackHandler) {
  backResolver = handler;
}

// ---------- Lifecycle ----------

interface NativeHooks {
  /** App sent to the background / brought back. */
  onPause?: () => void;
  onResume?: () => void;
  /** A room link opened the app (cold start or while running). */
  onRoomLink?: (code: string) => void;
}

export async function initNative(hooks: NativeHooks) {
  // The web gets the same pause/resume signal from visibilitychange, so the
  // audio behaves identically in a backgrounded browser tab.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hooks.onPause?.();
    else hooks.onResume?.();
  });

  if (!isNative) return;

  void StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
  void StatusBar.setBackgroundColor({ color: '#07090c' }).catch(() => {});

  void App.addListener('backButton', () => {
    if (backResolver()) return;
    void App.minimizeApp();
  });

  void App.addListener('appUrlOpen', ({ url }) => {
    const code = roomCodeFromUrl(url);
    if (code) hooks.onRoomLink?.(code);
  });

  // A cold start from a link delivers it here rather than as an event.
  try {
    const launch = await App.getLaunchUrl();
    const code = launch?.url ? roomCodeFromUrl(launch.url) : null;
    if (code) hooks.onRoomLink?.(code);
  } catch {
    /* no launch URL */
  }
}

/** Fades the launch splash once the menu has really painted — not on a
 *  timer, which either cuts to a half-drawn screen or holds a fast phone on
 *  the logo for nothing. */
export function hideSplashWhenPainted() {
  if (!isNative) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void SplashScreen.hide({ fadeOutDuration: 260 }).catch(() => {});
    })
  );
}
