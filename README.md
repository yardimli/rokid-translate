# Rokid Translate — first device test

Native Kotlin Android APK plus a Node.js diagnostic server and browser dashboard.
Designed for personal Rokid display glasses using the network configured through Hi Rokid. No Rokid SDK, no voice launch
requirement in our app. OpenAI translation runs through the Ubuntu server. Actual launcher visibility, permissions and microphone
availability must be verified on the glasses.

## First test features

- Android launcher entry: **My Translate Test**.
- Green-on-black UI; focusable Start microphone, Connect, Settings, log and Exit controls.
- Focused/pressed buttons invert to solid green with black text. The bottom 20% of the app
  window stays blank. Large rolling subtitles fill the upper area; smaller controls use one horizontal scrolling row below them.
- Local microphone RMS meter; PCM capture tries 24 kHz, then 48/16/44.1 kHz.
- Secure WebSocket audio streaming, server-side meter/counters and return captions.
- Device input events, connection diagnostics, RTT and bounded local/server logs.
- Reconnect with backoff and bounded audio queue; no replay of stale audio.
- Foreground-only operation: leaving the app stops microphone capture and disconnects.
- Dashboard controls target language, source transcription, noise reduction, caption length and font size.
- Live source and translated text appear in the dashboard; translation streams to the glasses.
- Each translation session saves input/translated WAV audio, plain-text transcripts and timestamped transcript deltas.
  Files are private, downloadable after dashboard login, and retained until manually removed.
- Diagnostic logs omit transcript content and credentials. Translation is off until enabled in the dashboard.

## Build on Windows

On this workstation, the initial build prepared an ignored `.tools/` folder with JDK 17 and the
Android build SDK. Run `./scripts/build-windows.ps1` to reuse them and place the APK in `dist/`.
`./scripts/package-server.ps1` creates an FTP-ready server ZIP without dependencies or secrets.

Open this repository folder in Android Studio. Install SDK Platform **35** and Build Tools **35.0.0**
in SDK Manager. Choose **JDK 17** for Gradle (Settings → Build Tools → Gradle → Gradle JDK).
Rabbit's bundled Java can be newer than this project's Gradle supports; use JDK 17 for this build.
The project pins AGP 8.9.2, Gradle 8.11.1, Kotlin 2.0.21 and OkHttp 4.12.0.
Target SDK is 35 and min SDK is 31, so it can run on Android-12-era glasses.
This is a private diagnostic build, not a Play Store release.

```powershell
$env:JAVA_HOME = 'C:\path\to\jdk-17'
$env:ANDROID_HOME = 'C:\Users\YOURNAME\AppData\Local\Android\Sdk'
.\gradlew.bat assembleDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`. Install through Hi Rokid's APK upload option.
Keep the same signing key and package name for updates; standard debug signing is sufficient for this
private prototype. Back up the debug keystore used for the delivered APK if continuing with that build.
The initial build's key is saved as ignored `debug.keystore` in the repository root; keep it for
future updates. If that file exists, Android Studio and the build script both use it.

The default server is `https://translate.playground.computer`. Enter DEVICE_TOKEN through Settings
(Hi Rokid's phone keyboard may help), or create an ignored `bootstrap.properties` before building:

```properties
serverUrl=https://translate.playground.computer
deviceToken=YOUR_DEVICE_TOKEN
```

This optionally embeds only the initial diagnostic device token, not an OpenAI key. Settings overrides
are saved on-device. No real secrets are committed. To change defaults after installation, update Settings
or clear app data; saved settings take precedence over build defaults.

## Network setup

Configure the glasses' network through Hi Rokid (for example, your Android phone's hotspot).
The app uses Android's default connection for translation streaming. Version 0.2.6 removes
all in-app Wi-Fi provisioning, connection tests, location/nearby Wi-Fi permissions, and the
custom password keyboard. Bootstrap configuration only includes server URL and device token.
Connect to the server, enable translation in the dashboard, then start the microphone.
The existing subtitle layout, focus colors, lower 20% margin, and compact diagnostic text remain.
The Device button reports Android/API level and firmware; it does not interrupt the initial
translation-ready screen. No server update is required.

## Emulator / Windows server

Use an Android API 31+ virtual device. In emulator Extended Controls, enable host microphone input.
For networking to a Node server on the Windows host, set app URL to `http://10.0.2.2:8787`.
Only debug builds permit cleartext for emulator/loopback addresses; real domains require HTTPS.

```powershell
cd server
npm ci
Copy-Item .env.example .env
# Set two different random tokens. For local browser use set PUBLIC_ORIGIN=http://localhost:8787
npm start
```

Open `http://localhost:8787`, sign in using DASHBOARD_USERNAME and DASHBOARD_PASSWORD from `.env`. App Settings uses DEVICE_TOKEN.
You can test the server/dashboard without any Android device by running, in a second terminal:

```powershell
node --env-file=.env scripts/simulate-device.js
```

This streams a synthetic tone (not microphone audio) and acknowledges test captions. Set SERVER_URL
to `https://translate.playground.computer` to run that same test against your deployed server.
Do not confuse emulator host alias `10.0.2.2` with the browser's `localhost` origin.
Native button/touch mappings, optical layout, sleep and mic routing still need device tests.
The foreground Activity keeps the screen awake while visible; this is not a battery benchmark.

## Dashboard login

Set `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` (at least 12 characters) in the server's
`.env` before deploying. Keep the existing `DASHBOARD_TOKEN` as the server-only session signing
secret. The browser uses a login form and an HTTP-only session cookie; there is no token field.
The glasses still use `DEVICE_TOKEN`. Sessions expire after 8 hours or a server restart.

## Ubuntu deployment

For the existing Ubuntu installation, clone this repository into
`/opt/rokid-translate`, then run:

```bash
cd /opt/rokid-translate
bash server/deploy/update.sh
```

The script pulls committed changes, installs dependencies, runs tests, activates a new server
release, restarts systemd, validates/reloads Apache and checks HTTPS health. All files stay inside `/opt/rokid-translate`: `.env`, logs and recordings live under `server/`,
with tested releases under the ignored `.deploy/` directory. Use `--update-apache` only when also deploying
the repository's existing translation SSL vhost template. The main PHP site stays untouched.
See [server/DEPLOY.md](server/DEPLOY.md) for the one-time Git migration, authentication,
requirements, rollback behavior, and the original standalone FTP installation instructions.
No Android build runs on Ubuntu. Changes must be committed and pushed before the server pulls them.

## Validation

```powershell
cd server
npm test
```

Tests cover authentication/origin checks, configuration, audio negotiation and metrics, caption
round trips, OpenAI protocol using a fake transport, final transcript draining, WAV files and private downloads.
No paid OpenAI call is made by tests. Build the APK with `assembleDebug`; run `lintDebug` for Android static checks.
Hardware acceptance: launcher entry → permission prompt → local mic meter → server bytes → caption
visible in glasses → exit stops capture. Repeat after a network interruption.

## Next milestones

Next: a direct glasses-to-OpenAI connection with server-fetched key/settings and optional
diagnostics-only telemetry. Direct mode and key distribution are not implemented yet.
