# Packaging FISSILE for Google Play

The Android app is a **Trusted Web Activity**: a thin native shell that runs
this site inside the user's own Chrome. The engine, the Three.js renderer and
the relay all work unchanged, there is no second codebase, and a web deploy
*is* an app update for everything except the shell itself.

The trade is real and worth knowing before you start: a TWA is still Chrome
under the hood. No native push, no Play Billing, and offline is only what the
service worker caches. If you later need any of those, the upgrade path is
Capacitor — same web build, but with a real native project to attach plugins
to. Don't take it until something actually requires it.

---

## What is already done

- `public/manifest.webmanifest` — name, `display: standalone`, theme colours,
  and 192/512/maskable icons.
- `public/sw.js` — the service worker. **Chrome will not offer installation
  without a fetch handler**, and a TWA is an installed PWA, so this is what
  makes an Android app possible at all. Registered from `main.ts` in
  production builds only.
- `public/.well-known/assetlinks.json` — present, with placeholders.
- `public/privacy.html` — Play requires a privacy policy URL for every
  listing. It is an accurate draft with bracketed values still to fill in and
  has not been reviewed by a lawyer.

## What is not

- **The name is not cleared.** FISSILE has not been checked for trademark, app
  store or domain conflicts (roadmap §15). A Play listing is a public,
  permanent, first-use-in-commerce record under that name, and the package id
  below can never be changed once published. Clear the name first.
- The relay is not deployed, so online play, ranks and friend codes do not
  work in production yet.

---

## 1. Pick the package id — permanently

```
com.yourdomain.reacton
```

This can **never** be changed after the first upload. A new id is a new app
with a new listing and no reviews or installs. Use a domain you control.

## 2. Install the toolchain

Bubblewrap needs a JDK and the Android SDK; it will offer to fetch them.

```bash
npm install -g @bubblewrap/cli
```

## 3. Generate the shell

Run this from an empty directory *outside* this repo — it produces a separate
Android project, not part of the web app.

```bash
bubblewrap init --manifest https://YOUR-DOMAIN/manifest.webmanifest
```

It will ask for the package id, the launcher name, and the colours, then
generate a signing keystore. **Keep that keystore and its password safe and
backed up** — losing it means you cannot ship an update to your own app ever
again. It is the one artefact in this whole process with no recovery path.

```bash
bubblewrap build
```

## 4. Upload, then complete the asset link

The SHA-256 fingerprint you need is **not** the one from your local keystore
if you use Play App Signing (the default, and recommended). Google re-signs
the app, so the fingerprint that matters only exists after the first upload.

1. Upload the `.aab` to Play Console — internal testing track is fine.
2. Go to **Release → Setup → App integrity → App signing key certificate**.
3. Copy the **SHA-256 certificate fingerprint**.
4. Put it, and your package id, into `public/.well-known/assetlinks.json`.
5. Redeploy the site.

Verify it resolves before testing the app:

```bash
curl https://YOUR-DOMAIN/.well-known/assetlinks.json
```

**If this file is wrong or missing, the app still runs but shows a browser
URL bar across the top** — that is the single most common TWA mistake, and
that bar is what makes it look like a bookmark instead of an app.

## 5. Listing requirements

Play will ask for all of these before you can publish:

- Privacy policy URL → `https://YOUR-DOMAIN/privacy.html`
- App icon, 512×512 → `public/icon-512.png`
- Feature graphic, 1024×500 → **not generated yet**; `scripts/make-icons.mjs`
  is where it would go, alongside the OG card.
- Phone screenshots, at least 2 → take from a real device, not the emulator.
- Content rating questionnaire, data safety form, target audience.

The data safety form is the one that needs care and matches what
`privacy.html` already documents: a device-local record, a guest account with
no email or password, an opt-out diagnostics channel that is **not currently
sending anywhere**, and no advertising or third-party trackers.

## Updating

A web deploy updates the app — no new upload needed. Only changes to the
shell (package id, launcher icon, name, targeted Android version) require
rebuilding and re-uploading the `.aab`.
