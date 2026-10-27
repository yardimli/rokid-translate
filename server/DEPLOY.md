# Ubuntu: FTP upload, Apache SSL, and an always-running Node.js service

This is a standalone upload package. No Git checkout or Android files are needed on Ubuntu.
Node receives live PCM, relays it to OpenAI when enabled, and records translation sessions locally.
The dashboard is served by this same process. Apache handles the public domain and certificate.
PHP can remain on your existing main-domain virtual host. A conventional PHP request is not the
persistent WebSocket worker we need; using Node behind Apache avoids changing your PHP setup.

## 1. Upload and install

Upload the **contents of the server folder**, including `package-lock.json`, `src/`, `public/`,
`deploy/`, and `.env.example`, to a staging directory using your FTP client. Hidden files may need
to be enabled in the client. Do not upload `node_modules`, local logs, or your Windows `.env`.
Use a directory outside the existing website DocumentRoot for the final installation.

Over SSH, replace `/home/YOURUSER/rokid-server-upload` below with that staging directory:

```bash
sudo mkdir -p /opt/rokid-test
sudo cp -a /home/YOURUSER/rokid-server-upload/. /opt/rokid-test/
sudo chown -R "$USER":"$(id -gn)" /opt/rokid-test
cd /opt/rokid-test
node --version
npm --version
```

Use Node.js **22 or 24 LTS**. If Node is missing or older, install a supported LTS version using
the instructions at https://nodejs.org/en/download for your Ubuntu version. Check `command -v node`:
the provided service assumes `/usr/bin/node`. If your installation uses another system path,
edit `ExecStart` accordingly. Avoid a Node executable inside your home directory for this service
(`ProtectHome=true` makes it inaccessible).

```bash
npm ci --omit=dev
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex')); console.log(require('crypto').randomBytes(32).toString('hex'))"
nano .env
```

Paste the first random value into `DEVICE_TOKEN` and the second into `DASHBOARD_TOKEN`.
Keep `HOST=127.0.0.1`, `PORT=8787`, and `PUBLIC_ORIGIN=https://translate.playground.computer`.
Do not include a trailing slash in PUBLIC_ORIGIN. Keep the tokens distinct.
The device token goes in the glasses app's Settings; the dashboard token goes in the browser.
Neither is an OpenAI API key. Add `OPENAI_API_KEY` separately; it stays on this server.

For a quick foreground test:

```bash
npm start
```

In another SSH shell, `curl http://127.0.0.1:8787/healthz` should return `ok: true`.
Stop the foreground process with Ctrl+C before starting systemd.

## 2. Keep it running after SSH disconnects and reboots

```bash
sudo useradd --system --user-group --home-dir /opt/rokid-test --shell /usr/sbin/nologin rokid-test
sudo mkdir -p /opt/rokid-test/logs /opt/rokid-test/recordings
sudo chown -R rokid-test:rokid-test /opt/rokid-test/logs /opt/rokid-test/recordings
sudo chown root:rokid-test /opt/rokid-test/.env
sudo chmod 640 /opt/rokid-test/.env
sudo cp /opt/rokid-test/deploy/rokid-test.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rokid-test
sudo systemctl status rokid-test
```

Skip `useradd` if that service account already exists. The process now survives SSH logout,
restarts on failure, and starts at boot. Node listens only on localhost; do not open port 8787
in the public firewall.

Useful commands:

```bash
sudo journalctl -u rokid-test -f
sudo systemctl restart rokid-test
sudo systemctl stop rokid-test
```

Structured device logs are in `/opt/rokid-test/logs/events.jsonl`, with one rotated previous file
(about 5 MiB each). Audio and caption contents are not written to these logs. The dashboard
shows/downloads the latest 500 events in memory; that history resets when Node restarts.

## 3. Add the subdomain to Apache and obtain SSL

Point the subdomain's DNS A record to this Ubuntu server. Only publish an AAAA record if IPv6
also reaches the correct server. Keep your existing `playground.computer` PHP vhost untouched.

Check `apache2 -v`: the supplied proxy directives require **Apache 2.4.47 or newer**.

```bash
sudo a2enmod proxy proxy_http ssl
sudo mkdir -p /var/www/translate-acme
sudo cp /opt/rokid-test/deploy/translate-http.conf /etc/apache2/sites-available/
sudo a2ensite translate-http
sudo apache2ctl configtest
sudo systemctl reload apache2
sudo certbot --apache -d translate.playground.computer
```

Let Certbot enable HTTP-to-HTTPS redirect. Then add the proxy configuration to the new TLS site.
You can either copy the Proxy directives from `deploy/translate-ssl.conf` into Certbot's generated
TLS vhost, **or** use the complete supplied file as follows:

```bash
sudo cp /opt/rokid-test/deploy/translate-ssl.conf /etc/apache2/sites-available/
sudo a2dissite translate-http-le-ssl
sudo a2ensite translate-ssl
sudo apache2ctl configtest
sudo systemctl reload apache2
```

Certbot's generated filename can differ: use `sudo apache2ctl -S` to identify it. Disable only
the generated TLS site for this subdomain, not your main PHP site. Keep one active TLS vhost
for the subdomain. If Certbot chose a certificate directory ending in `-0001`, update the
certificate paths in the template using `sudo certbot certificates`.

Open **https://translate.playground.computer/**, enter DASHBOARD_TOKEN and press Connect.
The page uses HTTPS and its live events use WSS through Apache. HTTP alone should redirect to HTTPS.
Also verify `sudo certbot renew --dry-run` with your existing renewal configuration.

## 4. Device test

In the APK's Settings, set `https://translate.playground.computer` and DEVICE_TOKEN.
Connect the glasses to the iPhone Wi-Fi hotspot. Press Connect server, then Start microphone.
The dashboard should list the glasses and show increasing bytes/chunks and changing audio levels.
Send a caption from the dashboard; check both the glasses and a `caption_applied` event.
The acknowledgement verifies that the app assigned the text, not that the optics displayed it.
The microphone stops and the connection closes when the app goes into the background.

## 5. Upload an update

Upload new server files to staging. Preserve the installed `.env`, `logs/` and `recordings/`.
Copy `src/`, `public/`, and the two package JSON files into `/opt/rokid-test`, then:

```bash
cd /opt/rokid-test
npm ci --omit=dev
sudo systemctl restart rokid-test
sudo journalctl -u rokid-test -n 50 --no-pager
```

## 6. Upgrade the existing installation to OpenAI translation (0.2.0)

Upload the new `src/`, `public/`, `deploy/`, `package.json` and `package-lock.json` from the ZIP.
Keep your existing `.env` and tokens. Add these lines to `/opt/rokid-test/.env`:

```dotenv
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
TARGET_LANGUAGE=en
RECORDINGS_DIR=./recordings
```

The systemd service needs write access to the new recordings directory. Run once after uploading:

```bash
cd /opt/rokid-test
npm ci --omit=dev
sudo mkdir -p /opt/rokid-test/recordings
sudo chown rokid-test:rokid-test /opt/rokid-test/recordings
sudo chmod 700 /opt/rokid-test/recordings
sudo cp deploy/rokid-test.service /etc/systemd/system/rokid-test.service
sudo systemctl daemon-reload
sudo systemctl restart rokid-test
sudo journalctl -u rokid-test -n 50 --no-pager
```

If you customized the installed service, instead add `/opt/rokid-test/recordings` to its
`ReadWritePaths` and keep your other changes. No Apache or SSL changes are needed.
For a different `RECORDINGS_DIR`, also update the service's writable path and directory ownership.

Install APK 0.2.0, reload the dashboard, authenticate, choose target language, check **Enable
translation**, then **Apply settings**. Connect and start the glasses microphone. The dashboard
shows OpenAI state, live source text and translated text. The glasses show the latest translated
caption with selectable size. Settings are shared across connected devices and last until Node
restarts. Default target language comes from `.env`; translation always starts disabled.

To change settings mid-session, uncheck Enable and Apply, wait for **stopped**, then choose the new
settings and enable again. Stopping the microphone also finishes the session and saves its files.
Translation stays enabled for the next microphone start. Closing the dashboard alone does not stop it.
OpenAI errors stop that session; disable/re-enable or restart the microphone after fixing the cause.

Each session directory under `recordings/` contains:

- `input.wav`: received glasses audio during translation, PCM16 mono 24 kHz.
- `translated.wav`: OpenAI's returned speech, PCM16 mono 24 kHz. It is saved, not played on the glasses.
- `source.txt` and `translation.txt`: continuous readable text. Source is empty if transcription is disabled.
- `transcripts.jsonl`: exact text deltas with receipt time and available OpenAI timing metadata.
- `metadata.json`: session settings, device, timestamps, byte counts and final state.

**Saved sessions** lists the latest 100 sessions. Downloads become available after finalization
and require DASHBOARD_TOKEN. WAV headers are finalized on stop; a process crash/power loss may
leave an unfinished recording (metadata says incomplete). Downloads are disabled for those files.
Audio and transcript files persist until you manually remove them. Each audio track is limited to
256 MiB per session; reaching the limit stops the session with a recording error. At 24 kHz, each
track uses about 2.9 MB per minute. Diagnostic mode without translation does not save audio.

This first relay accepts **24 kHz only** for translation. Other negotiated device rates still work
for diagnostics but show an explicit translation error; no incorrectly labeled audio is sent upstream.
If level remains exactly 0.000% while speaking, download input.wav and listen before judging model
quality. The dashboard flags consecutive all-zero chunks separately from low but nonzero audio.

The integration uses the dedicated translation WebSocket, not the conversational Realtime endpoint.
Target language, optional source transcription and noise reduction are supported; arbitrary prompts,
source-language selection and VAD tuning are not exposed by this translation protocol.
Official reference: https://developers.openai.com/api/docs/guides/realtime-translation

## Troubleshooting

- **502:** Node isn't running, its port differs, or its service cannot read `.env`. Check systemd logs.
- **Dashboard page loads but socket fails:** check the two WebSocket ProxyPass rules and Apache version.
- **Dashboard rejected:** check DASHBOARD_TOKEN and PUBLIC_ORIGIN (including scheme, no trailing slash).
- **Glasses HTTP 401:** wrong DEVICE_TOKEN. The browser and glasses deliberately use different tokens.
- **No microphone level:** permission, audio routing, or firmware; test the local meter before networking.
- **Connection unavailable during install:** the installer may change Wi-Fi networks. Rejoin the hotspot afterward.
- **Microphone stops when screen/app changes:** deliberate foreground-only scope of this initial test.

Protocol: see `PROTOCOL.md`. Apache reference: https://httpd.apache.org/docs/2.4/mod/mod_proxy.html
