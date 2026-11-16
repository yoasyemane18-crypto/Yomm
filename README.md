# YEME BINGO

**YEME BINGO** is a multiplayer Ethiopian Bingo stake-room application featuring real-time rooms, deterministic 5×5 bingo cards, Amharic/English voice calling, wallet deposits & withdrawals, and an admin management panel.

## Features

- **Multilingual UI**: Instant switching between **English**, **አማርኛ (Amharic)**, and **ትግርኛ (Tigrinya)**.
- **Stake Rooms**: 5 stake tiers (`10`, `20`, `50`, `100`, `200` ETB) synchronized on a 10-minute shared round cycle (3-minute join window, 5-second countdown, 75-ball draw every 5 seconds).
- **Live Bingo Gameplay**: Deterministic card previews and ball sequences, 6 rotating target goals (*Any Line*, *Four Corners*, *Both Diagonals*, *Plus Sign*, *Letter T*, *Full House*), manual or auto-mark, and Amharic/English text-to-speech ball calling.
- **Wallet**: Deposit and withdrawal request workflows for **Telebirr**, **CBE**, **CBE Birr**, and **E-Birr**, plus transaction history.
- **Admin Panel**: Payment approval/decline, withdrawal processing, user balance management, and 24-hour winner registry.
- **Data Persistence**: Backed by Firebase Realtime Database (`firebase-app-compat` / `firebase-database-compat` `10.12.2`) with automatic local storage fallback.

## Project Structure

- `index.html` — Single-file web app (also deployable directly via GitHub Pages).
- `app/src/main/assets/index.html` — Bundled Android asset copy of `index.html`.
- `app/src/main/java/com/yemebingo/app/MainActivity.kt` — Edge-to-edge Android `WebView` host using `WebViewAssetLoader` (`https://appassets.androidplatform.net`) for secure-context Web Crypto (`SHA-256`), `localStorage`, `tel:` dialer routing, and back navigation.

## Building the Android App

1. Open the repository in **Android Studio** (JDK 21, Android SDK 36) or use Gradle (`9.3.1+`).
2. Run:
   ```bash
   gradle assembleDebug
   ```
   The debug APK is generated at `app/build/outputs/apk/debug/app-debug.apk`.

## GitHub Actions Workflows

- **Android CI & APK Build (`.github/workflows/android.yml`)**: Automatically runs on every push/PR to `main` or `master` (and manually via `workflow_dispatch`). Verifies `index.html` and `app/src/main/assets/index.html` are identical, builds `app-debug.apk` with JDK 21 and Gradle `9.3.1`, and uploads it as a downloadable artifact (`yeme-bingo-debug-apk`).
- **Deploy Web App to GitHub Pages (`.github/workflows/pages.yml`)**: Enable **Settings → Pages → Source: GitHub Actions** and run this workflow from the **Actions** tab to publish the root `index.html`.
