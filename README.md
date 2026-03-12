# Arie AI — Desktop App

AI assistant for consultants. Electron app for macOS and Windows.

---

## Prerequisites

- Node.js 18+
- npm 9+
- macOS 12+ to build the Mac DMG and run `iconutil`
- Windows 10+ to build the NSIS installer (or cross-compile on Mac)

---

## Setup

```bash
unzip arie-electron-app.zip
cd arie-app
npm install
cp .env.example .env
```

Fill in `.env` with your Azure and Google OAuth credentials.

---

## Dev

```bash
npm run dev
```

Onboarding shows on first run. OAuth flows open the browser and catch the callback on localhost:3000.

---

## Icons — run once before building

```bash
npm install sharp png2icons --save-dev
node scripts/gen-icons.js
```

Then on macOS:

```bash
cd assets/icons/mac
iconutil -c icns icon.iconset -o icon.icns
cp icon.icns ../../icon.icns
cd ../../..
```

The `.ico` for Windows is generated automatically by the script.

---

## Build

### macOS unsigned (internal testing)

```bash
npm run build:mac:unsigned
```

Output: `dist/Arie AI-1.0.0-arm64.dmg` and `-x64.dmg`

Users will see a Gatekeeper warning — right-click → Open to bypass.

### macOS signed + notarized (distribution)

Requires an Apple Developer account ($99/year) and a Developer ID certificate in Keychain.

```bash
export APPLE_ID=your@apple.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=XXXXXXXXXX
npm run build:mac
```

Notarization takes 2-5 minutes. The DMG will open without Gatekeeper warnings on any Mac.

### Windows

```bash
npm run build:win
```

Output: `dist/Arie AI Setup 1.0.0.exe` (installer) and `dist/Arie AI 1.0.0.exe` (portable)

For signed builds (removes SmartScreen warning):

```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=your-cert-password
npm run build:win
```

### Both platforms

```bash
npm run build:all
```

---

## Auto-update setup

1. Create a private GitHub repo: `arie-ai/arie-ai`
2. Create a GitHub personal access token with `repo` scope
3. Add `GH_TOKEN=your-token` to `.env`
4. Publish a release: `electron-builder --publish always`

The app checks for updates every 4 hours and prompts users to restart when one is ready.

---

## OAuth setup

### Microsoft (Azure AD)

1. portal.azure.com → Azure AD → App registrations → New registration
2. Name: Arie AI — Accounts: Any org + personal Microsoft accounts
3. Redirect URI: Web → `http://localhost:3000/auth/microsoft/callback`
4. Certificates and secrets → New client secret → copy immediately
5. API permissions → Add: `Mail.ReadWrite` `Mail.Send` `Calendars.ReadWrite` `User.Read` `offline_access` → Grant admin consent
6. Copy Application ID and secret to `.env`

### Google

1. console.cloud.google.com → New project → Arie AI
2. Enable: Gmail API, Google Calendar API
3. OAuth consent screen → External → fill in app name
4. Credentials → OAuth 2.0 Client → Desktop app
5. Authorised redirect URI: `http://localhost:3000/auth/google/callback`
6. Copy client ID and secret to `.env`

---

## File structure

```
arie-app/
  src/
    main/
      index.js          Main process — IPC, OAuth, tray, auto-updater
      oauth-server.js   Local HTTP server catching OAuth callbacks
      providers.js      Microsoft Graph + Google API calls
    preload/
      index.js          Context bridge
    renderer/
      app.html          Main UI
      onboarding.html   First-run setup
  assets/
    icon.icns           macOS icon
    icon.ico            Windows icon
    icon.png            Linux icon
  build/
    entitlements.mac.plist
    license.txt
  scripts/
    gen-icons.js
    notarize.js
  .env.example
  package.json
  README.md
```
