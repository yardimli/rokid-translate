# Ubuntu deployment: Git updates, Apache SSL, and systemd

The recommended update workflow uses a Git checkout and the update script below.
The original FTP instructions remain available for initial setup and standalone uploads.
Node receives live PCM, relays it to OpenAI when enabled, and records translation sessions locally.
The dashboard is served by this same process. Apache handles the public domain and certificate.
PHP can remain on your existing main-domain virtual host. A conventional PHP request is not the
persistent WebSocket worker we need; using Node behind Apache avoids changing your PHP setup.

## Git deployment: one installation directory

Use `/opt/rokid-translate` for the checkout and all runtime data:

- `server/.env`: existing tokens, OpenAI key, and environment settings.
- `server/logs/` and `server/recordings/`: persistent data, ignored by Git.
- `.deploy/releases/` and `.deploy/current`: tested releases and active symlink, ignored by Git.

The existing systemd service and account remain named `rokid-test`; no second service is created.
The script replaces its unit so all runtime paths point inside `/opt/rokid-translate`.
Apache continues proxying to localhost:8787, so migration requires no vhost changes.

### Migrate the existing `/opt/rokid-test` installation

First commit and push the latest deployment changes from Windows, then pull them into your
already cloned `/opt/rokid-translate` checkout. Run Git and the update script as the normal
SSH user who owns that checkout, not as root. If needed, configure a read-only GitHub deploy
key for a private repository. Node 22+ must be installed at `/usr/bin/node`; npm, curl, Git,
and sudo access are required.

Stop the microphone and service before copying recordings so files are not changing:

```bash
cd /opt/rokid-translate
git pull --ff-only
sudo systemctl stop rokid-test
sudo cp -a /opt/rokid-test/.env server/.env
sudo mkdir -p server/logs server/recordings
sudo cp -a /opt/rokid-test/logs/. server/logs/
sudo cp -a /opt/rokid-test/recordings/. server/recordings/
sudo chown root:rokid-test server/.env
sudo chmod 640 server/.env
sudo chown -R rokid-test:rokid-test server/logs server/recordings
sudo chmod 700 server/logs server/recordings
```

Skip a copy command if that old data directory does not exist. These commands copy only
settings and runtime data, not the old source or node_modules. Use them once, before the new
installation starts recording. Do not repeat the migration copy over newer recordings/settings.

Check `server/.env` using `sudo nano server/.env`. Keep the existing credentials. If LOG_DIR
or RECORDINGS_DIR contain absolute `/opt/rokid-test/...` paths, change them to `./logs` and
`./recordings`. Keep HOST=127.0.0.1, PORT=8787, and
PUBLIC_ORIGIN=https://translate.playground.computer. Then deploy:

```bash
bash server/deploy/update.sh --no-pull
sudo systemctl status rokid-test --no-pager
sudo systemctl show rokid-test -p WorkingDirectory -p ExecStart -p ReadWritePaths
curl --fail https://translate.playground.computer/healthz
```

The displayed service paths must all use `/opt/rokid-translate`. Also open the dashboard,
check saved recordings, and test translation before removing the old directory. If deployment
fails, keep `/opt/rokid-test`: the previous unit is restored and you can restart it with
`sudo systemctl start rokid-test`. Custom systemd drop-ins are rejected because they may
still override the service with old paths; review them before migration.

Only after the above checks succeed, remove the old installation:

```bash
sudo rm -r -- /opt/rokid-test
```

This deletes the old copy of settings/recordings too. The new copies remain in `server/`.
Do not uninstall the `rokid-test` service or account: they now run the new location. Old
migration backups refer to the deleted installation and cannot restore it after deletion.

### Future updates

```bash
cd /opt/rokid-translate
bash server/deploy/update.sh
```

The script performs a fast-forward-only Git pull and executes the newly pulled script. It
refuses local changes rather than overwriting them. Use `--no-pull` if you already pulled.
It installs dependencies and runs tests in a temporary directory, prepares a release inside
`.deploy/releases`, switches `.deploy/current`, and restarts the service. The dashboard is
plain HTML/CSS/JavaScript: no frontend compilation or Android build is needed on Ubuntu.

Environment validation, Apache syntax checking, localhost health, and local HTTPS vhost
health are checked. Failures during activation attempt to restore the previous release/unit
and Apache config. The prior running/stopped service state is restored on failure. Check the
journal after a rollback; underlying server failures can also prevent recovery. Git stays
on the pulled commit. Releases and configuration backups are retained under `.deploy`.

`.env`, logs, and recordings are never overwritten by routine updates. A restart ends active
sessions; stop the microphone first, then reload the dashboard and enable translation again.

### Optional Apache configuration update

```bash
bash server/deploy/update.sh --update-apache
```

Ordinary updates only validate/reload existing Apache configuration. This option additionally
replaces `/etc/apache2/sites-available/translate-ssl.conf` from the repository, only if it
already exists and is enabled under that filename. It backs it up before replacement and
validates before reload. The main PHP site, HTTP redirect, certificates, and Certbot renewal
configuration are untouched. Do not enable duplicate TLS vhosts for the same domain.

For a Certbot-generated filename or custom certificate directory, keep using the default
command until you adapt the template/site setup. The template expects Apache 2.4.47+ and
`/etc/letsencrypt/live/translate.playground.computer/`. HTTPS verification checks this server
via loopback:443 with the domain's valid certificate, without bypassing certificate checks.

## Legacy FTP setup reference

The sections below describe the original `/opt/rokid-test` installation. After migrating,
use the Git workflow above; do not copy updates into the old directory or reinstall the old
`rokid-test.service` template. Git deployment uses `rokid-translate.service`, installed under
the existing systemd unit name `rokid-test.service`.

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
Configure the glasses network through Hi Rokid (for example, an Android phone hotspot). Press Connect server, then Start microphone.
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
