# The FISSILE Android app

From 1.1.0 (version code 5) the Play app is a **native Capacitor app**, not a
Trusted Web Activity. The whole game — code, 3D renderer, sounds, music — is
copied *into* the APK and runs from the phone's own storage:

- it opens instantly and works with no internet (everything except online
  play, which still talks to the relay);
- there is never a browser address bar, and it does not depend on which
  browser the phone has or whether Chrome is up to date;
- Android's back button, native haptics, the system share sheet, a dark launch
  splash and keep-screen-on during play are all wired in (`src/native.ts`).

The package name is unchanged (`com.designdynastystudios.fissile`), so this
uploads to the existing Play listing as an ordinary update.

## Build commands

| Command | What you get |
| --- | --- |
| `npm run android:debug` | `android/app/build/outputs/apk/debug/app-debug.apk` — sideload to test |
| `npm run android:bundle` | `android/app/build/outputs/bundle/release/app-release.aab` — the Play upload |
| `npm run android:apk` | signed release APK |
| `npm run android:open` | opens the project in Android Studio |

Each one rebuilds the web game, copies it into `android/` (`cap sync`) and
runs Gradle, so an APK always carries the current code. Java comes from
`JAVA_HOME`, or from the JDK inside Android Studio if that is unset.

The Gradle wrapper is pinned to **9.5.0**: Gradle 9.6 removed an internal API
that the Android Gradle Plugin 8.x still uses, and fails at configuration.

## Signing the Play build

Play only accepts an update signed with the **same upload key** as the
earlier builds (`android.keystore`, alias `android`). The build reads it from
a file you create yourself:

1. Copy `keystore.properties.example` to `keystore.properties`.
2. Fill in `storePassword` and `keyPassword`.
3. Run `npm run android:bundle` and upload the `.aab`.

`keystore.properties` and the keystore are gitignored. Never commit either.
Without the file, release builds come out unsigned (Play will reject them).

## Every release

Bump both in `android/app/build.gradle`:

- `versionCode` — must be higher than every build Play has ever seen (5 now);
- `versionName` — what players see (`1.1.0` now).

## Things to know about the switch

- **Saved data does not carry over from the old build.** The web-shell app
  stored progress in Chrome under the website's address; the native app has
  its own storage. Players who had the early-access build start fresh
  (local stats, settings, and the device's online account).
- **Minimum Android is now 7.0** (API 24, Capacitor's floor). The web shell
  allowed 5.0. Phones older than 7.0 keep the version they have.
- **Room links open the app.** Invites are `https://chainreaction-sooty.vercel.app/join?room=CODE`.
  With the app installed, Android opens them in the app (verified by
  `public/.well-known/assetlinks.json`, which already lists the Play signing
  certificate); without it they open the website. `fissile://room/CODE` also
  works. The `/join` path needs the web deploy that adds the rewrite in
  `vercel.json`.
- **Icons and splash** come from `npm run icons:app` then `npm run native:res`,
  which write into `android/app/src/main/res`.

## Troubleshooting

- *`cap sync` fails with EPERM / ENOTEMPTY*: something is holding files open
  under `android/`. Usually a running Gradle daemon (`android\gradlew.bat
  --stop`) or a file watcher. `vite.config.mjs` keeps the dev server's watcher
  out of `android/` for exactly this reason.
- *"There is not enough space on the disk"*: a release build needs a few
  hundred MB of scratch space under `android/app/build`. Free space on the
  drive, or delete `android/app/build` (it is regenerated).
