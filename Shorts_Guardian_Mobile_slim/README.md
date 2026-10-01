# Shorts Guardian — Mobile App (Capacitor)

Your Chrome extension, repackaged as an Android / iOS app. The original pipeline
(`background.js`, MobileNet + DistilBERT classifier, keyword tiers, MTRCB ratings,
weighted score, blocked-ID memory, the parent dashboard, PIN gate, PDF export) runs
**unchanged**; small shims replace the Chrome-only APIs.

## How it works on a phone
A phone app can't read inside the official YouTube app, so the child watches Shorts in
**Safe YouTube** (the green button in the app): an in-app browser locked to YouTube
domains with your content script injected. Each new Short → classify → overlay + auto-skip,
exactly like the extension. The parent dashboard is the normal app screen, behind the PIN.

**Important:** the child must not be able to use the YouTube app or Chrome instead.
Block those with Google Family Link (Android) or Screen Time (iOS), and leave only
Shorts Guardian allowed. Without that, the app can be bypassed.

## Build
```bash
npm install
npm run build:www            # regenerates www/ from extension-src/ + mobile-src/
npx cap sync
npm run android              # opens Android Studio → Run ▶ on a device
# iOS (needs a Mac + Xcode):  npx cap add ios && npm run ios
```
`npm test` runs a headless check of the real pipeline (flag, block, skip, revisit-block).

## What's the same / different
| Extension feature | Mobile |
|---|---|
| Keyword scan (title + channel) | Same. Titles come from YouTube oEmbed (the mobile site's DOM is unreliable) |
| MobileNet + DistilBERT on-device | Same code. Models download on first use, then cache |
| Claude Vision (API key) | Same, sent through native HTTP |
| MTRCB rating, weighted score, blocked categories, retention, PIN, dashboard, PDF | Same |
| Block overlay + auto-skip + re-block on revisit | Same |
| **Screenshot of the playing frame** | **Mostly the same:** copies the frame currently on screen from the `<video>` element (small JPEG). If YouTube blocks that (DRM / not ready after ~2 s), it falls back to the Short's thumbnail (`i.ytimg.com`), which is a single still and can miss content that appears later in the video |
| **Audio transcription (Whisper)** | **Not available:** phones don't allow capturing another page's audio. Switched off |
| Cross-device settings sync | Not available (`chrome.storage.sync` is device-local here) |
| Gmail alerts | Needs setup, see below |
| Toolbar badge/popup | Dropped (no toolbar on mobile) |

## Gmail alerts
1. Google Cloud Console → create an OAuth **Web application** client ID, add the Gmail API.
2. Put it in `mobile-src/config.js` (`googleWebClientId`), rebuild.
3. Android/iOS client IDs for the app's package (`com.shortsguardian.app`) are also required
   by the sign-in plugin (`@capgo/capacitor-social-login` docs).
4. Unlock the dashboard → tap **Connect Gmail**.

Limitation: mobile Google tokens last ~1 hour and can't be refreshed silently, so emails
stop until the parent reconnects. For dependable alerts, use a small server or push
notifications instead (recommended next step).

## Not yet verified
Built and tested headlessly here, **not on a physical device** (no Android SDK/iPhone available).
Things to check first: that live-frame capture works in your Android/iOS web view (log shows `visionMode` and the saved snapshot; a blank/black snapshot means it fell back or was blocked), the in-app browser message bridge on your Android/iOS version,
Safe YouTube navigation lock, model download speed, and that the classifier keeps running
while the in-app browser is on top.

## Get the APK without installing anything (GitHub Actions)
1. Create a free GitHub account and a **new private repository**.
2. Upload this whole project (drag the unzipped folder into the repo page, or use git).
   Make sure the `.github/workflows/build-apk.yml` file is included.
3. Open the repo → **Actions** tab → **Build Android APK** → **Run workflow**
   (it also runs on every push). Wait ~5–10 minutes.
4. Open the finished run → **Artifacts** → download **ShortsGuardian-debug-apk**, unzip → `app-debug.apk`.
5. Copy the APK to the phone, open it, and allow "Install unknown apps" when asked.

This is a *debug-signed* APK: fine for installing on your own/your child's phone,
not for the Play Store. For the Play Store you need a release keystore and `assembleRelease`.

## Or build locally
Install Android Studio, then `npm install && npm run android` → Build → Build APK(s).
