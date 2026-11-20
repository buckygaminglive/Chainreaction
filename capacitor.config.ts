import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The native Android shell.
 *
 * The web build in dist/ is copied *into* the APK by `npx cap sync`, so an
 * installed copy of the game loads from the phone's own storage: it opens with
 * no network, never shows a browser address bar, and does not depend on which
 * browser the phone has. The relay is still reached over the network for
 * online play, which is the only part of the game that needs one.
 *
 * appId is the Play listing's package name and can never change — it has to
 * match the app already published from the earlier web-shell build, or Play
 * treats this as a different app.
 */
const config: CapacitorConfig = {
  appId: 'com.designdynastystudios.fissile',
  appName: 'FISSILE',
  webDir: 'dist',
  backgroundColor: '#07090c',
  android: {
    // Served as https://localhost so the page is a secure context (Web Audio,
    // clipboard and crypto.randomUUID all require one).
    allowMixedContent: false,
    backgroundColor: '#07090c',
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      // Held until the menu has actually painted, then faded by the app — see
      // native.ts. Auto-hiding on a timer either cuts to a half-drawn screen or
      // makes a fast phone wait for nothing.
      launchAutoHide: false,
      backgroundColor: '#07090c',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
  },
};

export default config;
