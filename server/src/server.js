import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createDashboardAuth } from './dashboard-auth.js';
import { createTranslationSession } from './translation.js';
import { createRecording, listRecordings, recordingFiles } from './recordings.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const clean = (x, n = 160) => String(x ?? '').replace(/[\x00-\x1f]/g, ' ').slice(0, n);

export function createDiagnosticServer({ deviceToken, dashboardToken, dashboardUsername, dashboardPassword, origin, logDir, openaiApiKey = '',
  recordingsDir, targetLanguage = 'en', translationFactory = createTranslationSession }) {
  for (const token of [deviceToken, dashboardToken]) {
    if (!token || token.length < 24 || token.startsWith('replace-')) throw new Error('Set two random tokens of at least 24 characters in .env');
  }
  if (deviceToken === dashboardToken) throw new Error('Device and dashboard tokens must differ');
  if (!origin || !/^https?:\/\//.test(origin)) throw new Error('PUBLIC_ORIGIN must be your dashboard origin');
  const auth = createDashboardAuth({ username: dashboardUsername, password: dashboardPassword, secret: dashboardToken, origin });
  const devices = new Map(), dashboards = new Set(), events = [];
  const translations = new Map(), finalizing = new Set();
  const languages = { en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', ru: 'Russian', hi: 'Hindi', id: 'Indonesian', vi: 'Vietnamese' };
  let settings = { enabled: false, targetLanguage: Object.hasOwn(languages, targetLanguage) ? targetLanguage : 'en',
    sourceTranscript: true, noiseReduction: 'off', captionChars: 240, fontSize: 26 };
  const settingsMessage = () => ({ type: 'settings', settings, languages, model: 'gpt-realtime-translate',
    apiKeyConfigured: Boolean(openaiApiKey), recordingEnabled: Boolean(recordingsDir) });
  let logBytes = 0;
  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    try { logBytes = fs.statSync(path.join(logDir, 'events.jsonl')).size; } catch {}
  }
  const send = (ws, data) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) { ws.close(1013, 'Slow connection'); return; }
    ws.send(JSON.stringify(data));
  };
  const broadcast = data => { for (const ws of dashboards) send(ws, data); };
  function log(kind, deviceId, details = {}) {
    const event = { time: new Date().toISOString(), kind, deviceId, ...details };
    events.push(event); if (events.length > 500) events.shift();
    if (logDir) {
      try {
        const file = path.join(logDir, 'events.jsonl');
        if (logBytes > 5 * 1024 * 1024) {
          const previous = path.join(logDir, 'events.previous.jsonl');
          if (fs.existsSync(previous)) fs.unlinkSync(previous);
          fs.renameSync(file, previous); logBytes = 0;
        }
        const line = JSON.stringify(event) + '\n';
        fs.appendFileSync(file, line); logBytes += Buffer.byteLength(line);
      } catch { console.error('Could not write diagnostic log'); }
    }
    broadcast({ type: 'event', event });
  }
  const snapshot = () => [...devices.values()].map(({ ws, ...d }) => d);
  function subtitle(d, text) {
    const captionId = randomUUID();
    send(d.ws, { type: 'caption', captionId, text: text.slice(-settings.captionChars), fontSize: settings.fontSize, live: true });
  }
  function startTranslation(d) {
    if (!settings.enabled || !d.streaming || translations.has(d.id)) return;
    if (!openaiApiKey || d.sampleRate !== 24000) {
      d.translationState = !openaiApiKey ? 'error: OPENAI_API_KEY missing' : 'error: translation requires 24000 Hz';
      send(d.ws, { type: 'translation_status', state: d.translationState }); return;
    }
    const run = { text: '', source: '', timer: null, recording: null, session: null, lastAudioAt: Date.now(), stopping: false };
    run.done = new Promise(resolve => { run.resolveDone = resolve; });
    translations.set(d.id, run);
    d.translation = ''; d.source = ''; d.translationState = 'connecting';
    send(d.ws, { type: 'translation_status', state: d.translationState });
    subtitle(d, '');
    function state(value) {
      if (translations.get(d.id) !== run) return;
      d.translationState = value;
      send(d.ws, { type: 'translation_status', state: value });
      log('translation_state', d.id, { state: value });
      if (value === 'stopped' || value.startsWith('error:')) {
        clearTimeout(run.timer); subtitle(d, run.text);
        translations.delete(d.id);
        if (run.recording) {
          const promise = run.recording.close(value).then(() => broadcast({ type: 'recordings', recordings: listRecordings(recordingsDir) }));
          finalizing.add(promise); promise.finally(() => { finalizing.delete(promise); run.resolveDone(); });
        } else run.resolveDone();
      }
    }
    if (recordingsDir) {
      try {
        run.recording = createRecording(recordingsDir, { deviceId: d.id, name: d.name, settings: { ...settings }, model: 'gpt-realtime-translate' }, () => {
          log('recording_error', d.id); state('error: recording_write_failed'); run.session?.abort();
        });
        d.recordingId = run.recording.id;
      } catch { state('error: recording_create_failed'); return; }
    }
    log('translation_start', d.id, { targetLanguage: settings.targetLanguage, recordingId: d.recordingId });
    run.session = translationFactory({ apiKey: openaiApiKey, settings: { ...settings }, onState: state,
      onText(kind, delta, elapsedMs) {
        if (translations.get(d.id) !== run) return;
        run.recording?.text(kind, delta, elapsedMs);
        if (kind === 'translation') { run.text = (run.text + delta).slice(-6000); d.translation = run.text; }
        else { run.source = (run.source + delta).slice(-6000); d.source = run.source; }
        broadcast({ type: 'transcript', deviceId: d.id, kind, text: kind === 'translation' ? run.text : run.source });
        if (kind === 'translation' && !run.timer) run.timer = setTimeout(() => { run.timer = null; subtitle(d, run.text); }, 150);
      },
      onAudio(pcm) { run.recording?.audio('translated', pcm); },
      onEvent(kind) { log(kind, d.id); }
    });
  }
  function stopTranslation(d, abort = false) {
    const run = translations.get(d.id);
    if (!run) return;
    run.stopping = true;
    if (abort) run.session?.abort(); else run.session?.stop();
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://localhost');
    if (await auth.handle(req, res, url.pathname)) return;
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (url.pathname.startsWith('/api/recordings')) {
      if (!auth.session(req)) { res.writeHead(401); res.end(); return; }
      const match = url.pathname.match(/^\/api\/recordings\/([a-f0-9-]{36})\/(input\.wav|translated\.wav|transcripts\.jsonl|source\.txt|translation\.txt|metadata\.json)$/);
      if (!recordingsDir || !match || !recordingFiles.includes(match[2])) { res.writeHead(404); res.end(); return; }
      const info = listRecordings(recordingsDir).find(r => r.id === match[1]);
      if (!info?.complete) { res.writeHead(409); res.end('Stop translation before downloading.'); return; }
      const file = path.join(recordingsDir, match[1], match[2]);
      if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', match[2].endsWith('.wav') ? 'audio/wav' : 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${match[1]}-${match[2]}"`);
      const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
    }
    if (url.pathname === '/healthz') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"mode":"translation-relay"}'); return; }
    if (url.pathname === '/api/config') {
      if (!safeEqual(req.headers.authorization, `Bearer ${deviceToken}`)) { res.writeHead(401); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ protocolVersion: 1, mode: 'translation-relay', audioStored: Boolean(recordingsDir), translationEnabled: settings.enabled })); return;
    }
    const files = { '/': ['index.html', 'text/html'], '/dashboard.js': ['dashboard.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const entry = files[url.pathname];
    if (!entry) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', entry[1]); res.end(fs.readFileSync(path.join(publicDir, entry[0])));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const isDevice = url.pathname === '/device';
    const dashboardSession = isDevice ? null : auth.session(req);
    const valid = isDevice ? safeEqual(req.headers.authorization, `Bearer ${deviceToken}`) : url.pathname === '/dashboard' && req.headers.origin === origin && dashboardSession;
    if (!valid || wss.clients.size >= 16) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => { if (dashboardSession) auth.attach(dashboardSession, ws); onConnect(ws, isDevice); });
  });
  function onConnect(ws, isDevice) {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    let d, count = 0, windowStart = Date.now();
    if (isDevice) {
      const id = randomUUID();
      d = { id, ws, connectedAt: new Date().toISOString(), name: 'Connecting', streaming: false, bytes: 0, chunks: 0, rms: 0, sampleRate: 0, lastAudioAt: null };
      devices.set(id, d); log('connected', id); send(ws, { type: 'welcome', deviceId: id, protocolVersion: 1 });
    }
    if (!isDevice) {
      dashboards.add(ws);
      send(ws, { type: 'snapshot', devices: snapshot(), events }); send(ws, settingsMessage());
      send(ws, { type: 'recordings', recordings: listRecordings(recordingsDir) });
    }
    ws.on('message', (data, binary) => {
      try {
        if (Date.now() - windowStart >= 1000) { count = 0; windowStart = Date.now(); }
        if (++count > 100) { ws.close(1008, 'Message rate exceeded'); return; }
        if (binary) {
          if (!d?.streaming || data.length === 0 || data.length % 2) { ws.close(1008, 'Audio requires stream_start and PCM16'); return; }
          d.bytes += data.length; d.chunks++; d.lastAudioAt = new Date().toISOString();
          let sum = 0; for (let i = 0; i < data.length; i += 2) sum += (data.readInt16LE(i) / 32768) ** 2;
          d.rms = Math.sqrt(sum / (data.length / 2));
          d.peakRms = Math.max(d.peakRms || 0, d.rms);
          d.silentChunks = d.rms === 0 ? (d.silentChunks || 0) + 1 : 0;
          const run = translations.get(d.id);
          if (run && !run.stopping) { run.lastAudioAt = Date.now(); run.recording?.audio('input', data); run.session.push(data); }
          return;
        }
        const m = JSON.parse(data.toString());
        if (!isDevice) {
          if (m.type === 'settings') {
            const s = m.settings;
            if (!s || typeof s.enabled !== 'boolean' || !Object.hasOwn(languages, s.targetLanguage) || typeof s.sourceTranscript !== 'boolean' ||
              !['off', 'near_field', 'far_field'].includes(s.noiseReduction) || ![120, 240, 400].includes(s.captionChars) || ![22, 26, 30, 34].includes(s.fontSize)) {
              send(ws, { type: 'error', message: 'Invalid translation settings.' }); return;
            }
            if (s.enabled && !openaiApiKey) { send(ws, { type: 'error', message: 'Set OPENAI_API_KEY in the server .env and restart Node.' }); return; }
            if ([...translations.values()].some(run => run.stopping) || (settings.enabled && s.enabled && translations.size)) {
              send(ws, { type: 'error', message: 'Disable translation and wait for it to finish before changing settings.' }); return;
            }
            settings = { enabled: s.enabled, targetLanguage: s.targetLanguage, sourceTranscript: s.sourceTranscript,
              noiseReduction: s.noiseReduction, captionChars: s.captionChars, fontSize: s.fontSize };
            for (const d of devices.values()) { if (settings.enabled) startTranslation(d); else stopTranslation(d); }
            broadcast(settingsMessage()); log('translation_settings', null, { ...settings });
          }
          if (m.type === 'recordings') send(ws, { type: 'recordings', recordings: listRecordings(recordingsDir) });
          if (m.type === 'caption') {
            const target = devices.get(m.deviceId);
            const text = clean(m.text, 400).trim();
            if (!target || !text) { send(ws, { type: 'error', message: 'Choose a connected device and enter a caption.' }); return; }
            const captionId = randomUUID();
            send(target.ws, { type: 'caption', captionId, text });
            log('caption_sent', target.id, { captionId, characters: text.length });
          }
          return;
        }
        switch (m.type) {
          case 'hello':
            d.name = clean(m.name, 80); d.appVersion = clean(m.appVersion, 30);
            log('hello', d.id, { name: d.name, appVersion: d.appVersion }); break;
          case 'stream_start':
            if (![16000, 24000, 44100, 48000].includes(m.sampleRate) || m.channels !== 1 || m.format !== 'pcm16le') { ws.close(1008, 'Unsupported audio format'); return; }
            stopTranslation(d, true);
            d.streaming = true; d.sampleRate = m.sampleRate; d.bytes = 0; d.chunks = 0; d.rms = 0; d.peakRms = 0; d.silentChunks = 0;
            log('stream_started', d.id, { sampleRate: d.sampleRate }); startTranslation(d); break;
          case 'stream_stop': d.streaming = false; d.rms = 0; stopTranslation(d); log('stream_stopped', d.id, { bytes: d.bytes }); break;
          case 'ping': send(ws, { type: 'pong', sentAt: Number(m.sentAt) || 0 }); break;
          case 'caption_ack': log('caption_applied', d.id, { captionId: clean(m.captionId, 40) }); break;
          case 'diagnostic':
            // Whitelist fields: never serialize arbitrary messages, credentials or audio.
            log('device_diagnostic', d.id, { event: clean(m.event, 60), value: clean(m.value, 120) }); break;
          default: send(ws, { type: 'error', message: 'Unknown message type' });
        }
      } catch { ws.close(1008, 'Invalid message'); }
    });
    ws.on('close', () => { dashboards.delete(ws); if (d) { stopTranslation(d); devices.delete(d.id); log('disconnected', d.id); } });
  }
  const metrics = setInterval(() => {
    auth.expire();
    for (const [id, run] of translations) {
      if (!run.stopping && Date.now() - run.lastAudioAt > 5000) {
        run.stopping = true; log('audio_stalled', id); run.session.stop();
      }
    }
    broadcast({ type: 'metrics', devices: snapshot() });
    for (const d of devices.values()) send(d.ws, { type: 'stats', bytes: d.bytes, chunks: d.chunks, rms: d.rms });
  }, 1000);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 15000);
  return { server, close: async () => {
    clearInterval(metrics); clearInterval(heartbeat);
    const active = [...translations.values()];
    for (const run of active) { run.stopping = true; run.session?.stop(); }
    let shutdownTimer;
    await Promise.race([Promise.all(active.map(run => run.done)), new Promise(resolve => { shutdownTimer = setTimeout(resolve, 16000); })]);
    clearTimeout(shutdownTimer);
    for (const run of [...translations.values()]) run.session?.abort();
    await Promise.allSettled([...finalizing]);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  } };
}
