# Diagnostic protocol v1

All public connections use TLS. Node itself binds to localhost behind Apache.

- `GET /`: dashboard (no private data until WebSocket authentication).
- `GET /healthz`: basic process health, not OpenAI/device health.
- `GET /api/config`: `Authorization: Bearer DEVICE_TOKEN`; returns relay/recording capabilities, never keys.
- `WS /device`: same Authorization header. Server assigns a new session/device ID on each connection.
- `POST /api/login`: same-origin JSON `{username,password}` matching DASHBOARD_USERNAME/PASSWORD.
  Sets an HttpOnly, SameSite=Strict cookie (Secure + __Host- prefix on HTTPS); credentials are not logged.
- `GET /api/session`: 200 for an authenticated session, otherwise 401.
- `POST /api/logout`: same-origin; revokes the cookie/session and closes its dashboard sockets.
- `WS /dashboard`: browser Origin must equal PUBLIC_ORIGIN and a valid session cookie is required
  at upgrade. Snapshot/settings/recordings are sent immediately; no token auth message is used.
  DASHBOARD_TOKEN signs opaque sessions on the server and is never returned to the browser.
  Sessions expire after 8 hours and are invalidated by server restart. Login is limited to
  20 attempts per minute globally for this single-user application.

Device sends JSON `hello` with `name` and `appVersion`, then `stream_start` with
`sampleRate` (16000/24000/44100/48000), `channels:1`, `format:"pcm16le"` before binary audio frames.
Binary messages contain signed 16-bit little-endian mono PCM. The app aims for 200 ms per frame;
shorter device reads are accepted. Node computes RMS. When translation is enabled, 24 kHz audio
is recorded and forwarded to OpenAI; other rates are diagnostic-only.
`stream_stop` stops audio accounting; a new `stream_start` resets counters. Reconnects require a fresh start.
There is no compressed audio, WAV header, or base64 on this leg.

Server emits `stats` once per second with bytes, chunks and RMS. Devices can send `ping` with a
monotonic `sentAt` number; `pong` echoes it so the device calculates RTT without clock synchronization.
WebSocket ping/pong also detects dead connections.

Dashboard sends `caption` with `deviceId` and `text` (up to 400 characters). Server assigns a
`captionId`; device applies the text and returns `caption_ack` with that ID. Captions are not translation.
Dashboard receives `snapshot`, `metrics`, and `event` messages. Device `diagnostic` messages accept
only `event` and `value`; do not put credentials, transcript text or audio in those fields.

Limits: 16 sockets, 64 KiB per message, 100 messages/second per socket, bounded outbound queues,
500 in-memory events, and approximately 10 MiB of rotating on-disk logs. The app drops a stale socket
when its queued audio exceeds about one second, then reconnects without replaying old audio.

Dashboard `settings` messages carry `enabled`, `targetLanguage`, `sourceTranscript`, `noiseReduction`
(`off`, `near_field`, `far_field`), `captionChars` (120/240/400) and `fontSize` (22/26/30/34).
The authenticated response includes settings, languages and booleans for key/recording availability,
never the API key. Settings are global and in memory. Disable and drain before editing a live session.
`transcript` events mirror bounded full text per device/kind (`source` or `translation`). Full exact
deltas are persisted separately. `caption` events with `live:true` carry a rolling suffix and fontSize;
`translation_status` reports upstream lifecycle/errors. Captions remain compatible with older APKs.

`recordings` requests/responses list session metadata. `GET /api/recordings/{id}/{file}` requires
a valid dashboard session cookie and a finalized recording; the server allows only its recording filenames.
Files never live under the public directory. Audio and text are recorded only while translation is active.

OpenAI leg: WSS `/v1/realtime/translations?model=gpt-realtime-translate`, Bearer OPENAI_API_KEY.
After `session.update` and `session.updated`, audio uses `session.input_audio_buffer.append`
with base64 PCM16 mono 24 kHz. Source/output transcript deltas append exactly; no spaces are invented.
Output audio is saved locally. Stop sends `session.close`, drains through `session.closed`, then
finalizes files. Startup audio queue is limited to two seconds; upstream send buffering is bounded.
Audio inactivity >5 seconds stops the session. Errors require explicit restart rather than silently replaying audio.

Future direct OpenAI mode must keep the optional diagnostics connection separate from audio.
Key distribution and direct mode are not implemented yet.
