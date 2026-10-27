import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createDiagnosticServer } from '../src/server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const deviceToken = 'device-test-token-000000000000000000';
const dashboardToken = 'dashboard-test-token-000000000000000';
function messages(ws) {
  const pending = [], received = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    const index = pending.findIndex(p => p.predicate(m));
    if (index >= 0) { const [p] = pending.splice(index, 1); clearTimeout(p.timer); p.resolve(m); }
    else received.push(m);
  });
  return predicate => {
    const index = received.findIndex(predicate);
    if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const p = { predicate, resolve, timer: setTimeout(() => reject(new Error('Timed out waiting for event')), 4000) }; pending.push(p);
    });
  };
}
async function fixture(t, options = {}) {
  const app = createDiagnosticServer({ deviceToken, dashboardToken, origin: 'http://localhost', ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, wsBase: base.replace('http:', 'ws:') };
}
test('configuration is device-authenticated, secrets are never returned', async t => {
  const { base } = await fixture(t);
  assert.equal((await fetch(base + '/api/config')).status, 401);
  const response = await fetch(base + '/api/config', { headers: { Authorization: `Bearer ${deviceToken}` } });
  assert.deepEqual(await response.json(), { protocolVersion: 1, mode: 'translation-relay', audioStored: false, translationEnabled: false });
  assert.equal((await fetch(base + '/.env')).status, 404);
});
test('device auth and dashboard origin are enforced', async t => {
  const { wsBase } = await fixture(t);
  for (const [route, options] of [['/device', {}], ['/dashboard', { origin: 'https://evil.invalid' }]]) {
    const ws = new WebSocket(wsBase + route, options);
    const [req, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 401); res.resume(); req.destroy();
  }
});
test('wrong dashboard token is rejected', async t => {
  const { wsBase } = await fixture(t);
  const ws = new WebSocket(wsBase + '/dashboard', { origin: 'http://localhost' });
  await once(ws, 'open'); const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'auth', token: deviceToken }));
  assert.equal((await closed)[0], 1008);
});
test('PCM flows to metrics; captions return and are acknowledged; disconnect removes device', async t => {
  const { wsBase } = await fixture(t);
  const dashboard = new WebSocket(wsBase + '/dashboard', { origin: 'http://localhost' });
  const nextDashboard = messages(dashboard);
  await once(dashboard, 'open'); dashboard.send(JSON.stringify({ type: 'auth', token: dashboardToken }));
  await nextDashboard(m => m.type === 'snapshot');
  const device = new WebSocket(wsBase + '/device', { headers: { Authorization: `Bearer ${deviceToken}` } });
  const nextDevice = messages(device);
  const welcome = await nextDevice(m => m.type === 'welcome');
  device.send(JSON.stringify({ type: 'hello', name: 'Test glasses', appVersion: 'test' }));
  device.send(JSON.stringify({ type: 'stream_start', sampleRate: 24000, channels: 1, format: 'pcm16le' }));
  const audio = Buffer.alloc(9600); for (let i = 0; i < audio.length; i += 2) audio.writeInt16LE(16384, i);
  device.send(audio);
  const metrics = await nextDashboard(m => m.type === 'metrics' && m.devices[0]?.bytes === 9600);
  assert.equal(metrics.devices[0].rms, 0.5); assert.equal(metrics.devices[0].chunks, 1);
  dashboard.send(JSON.stringify({ type: 'caption', deviceId: welcome.deviceId, text: '你好 — Hello' }));
  const caption = await nextDevice(m => m.type === 'caption'); assert.equal(caption.text, '你好 — Hello');
  device.send(JSON.stringify({ type: 'caption_ack', captionId: caption.captionId }));
  const applied = await nextDashboard(m => m.type === 'event' && m.event.kind === 'caption_applied');
  assert.equal(applied.event.captionId, caption.captionId);
  device.send(JSON.stringify({ type: 'stream_stop' }));
  await nextDashboard(m => m.type === 'event' && m.event.kind === 'stream_stopped');
  device.close(); await nextDashboard(m => m.type === 'event' && m.event.kind === 'disconnected');
  const empty = await nextDashboard(m => m.type === 'metrics' && m.devices.length === 0); assert.deepEqual(empty.devices, []);
});
test('audio before format negotiation is rejected', async t => {
  const { wsBase } = await fixture(t);
  const device = new WebSocket(wsBase + '/device', { headers: { Authorization: `Bearer ${deviceToken}` } });
  await once(device, 'open'); const closed = once(device, 'close'); device.send(Buffer.alloc(100));
  assert.equal((await closed)[0], 1008);
});

test('translation routes PCM, mirrors exact deltas, drains final text and saves authenticated recordings', async t => {
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokid-recording-test-'));
  let callbacks, pushed = [], stopped = false;
  const { base, wsBase } = await fixture(t, { recordingsDir, openaiApiKey: 'fake-private-key', translationFactory(options) {
    callbacks = options;
    queueMicrotask(() => options.onState('translating'));
    return { push(pcm) { pushed.push(pcm); }, stop() {
      stopped = true; options.onState('finishing');
      setTimeout(() => { options.onText('translation', '!'); options.onState('stopped'); }, 10);
    }, abort() { options.onState('stopped'); } };
  } });
  t.after(() => fs.rmSync(recordingsDir, { recursive: true, force: true }));
  const dashboard = new WebSocket(wsBase + '/dashboard', { origin: 'http://localhost' });
  const next = messages(dashboard);
  await once(dashboard, 'open'); dashboard.send(JSON.stringify({ type: 'auth', token: dashboardToken }));
  const initial = await next(m => m.type === 'settings');
  assert.equal(initial.apiKeyConfigured, true); assert.equal(initial.settings.enabled, false);
  assert.ok(!JSON.stringify(initial).includes('fake-private-key'));
  const settings = { ...initial.settings, enabled: true, targetLanguage: 'ja' };
  dashboard.send(JSON.stringify({ type: 'settings', settings }));
  await next(m => m.type === 'settings' && m.settings.enabled);
  const device = new WebSocket(wsBase + '/device', { headers: { Authorization: `Bearer ${deviceToken}` } });
  const nextDevice = messages(device); await nextDevice(m => m.type === 'welcome');
  device.send(JSON.stringify({ type: 'stream_start', sampleRate: 24000, channels: 1, format: 'pcm16le' }));
  await next(m => m.type === 'event' && m.event.state === 'translating');
  assert.equal(callbacks.settings.targetLanguage, 'ja');
  const pcm = Buffer.alloc(9600, 1); device.send(pcm);
  await next(m => m.type === 'metrics' && m.devices[0]?.bytes === 9600);
  assert.deepEqual(pushed, [pcm]);
  callbacks.onText('source', '你好', 200); callbacks.onText('translation', 'こん', 200); callbacks.onText('translation', 'にちは', 400);
  callbacks.onAudio(pcm);
  const mirrored = await next(m => m.type === 'transcript' && m.text === 'こんにちは');
  assert.equal(mirrored.kind, 'translation');
  const caption = await nextDevice(m => m.type === 'caption' && m.text === 'こんにちは');
  assert.equal(caption.live, true);
  device.send(JSON.stringify({ type: 'stream_stop' }));
  const saved = await next(m => m.type === 'recordings' && m.recordings[0]?.complete);
  assert.equal(stopped, true);
  await nextDevice(m => m.type === 'caption' && m.text === 'こんにちは!');
  const id = saved.recordings[0].id;
  const fileUrl = `${base}/api/recordings/${id}/input.wav`;
  assert.equal((await fetch(fileUrl)).status, 401);
  assert.equal((await fetch(fileUrl, { headers: { Authorization: `Bearer ${deviceToken}` } })).status, 401);
  const response = await fetch(fileUrl, { headers: { Authorization: `Bearer ${dashboardToken}` } });
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
  const transcript = fs.readFileSync(path.join(recordingsDir, id, 'transcripts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(transcript.filter(x => x.kind === 'translation').map(x => x.delta).join(''), 'こんにちは!');
  assert.equal(fs.readFileSync(path.join(recordingsDir, id, 'translation.txt'), 'utf8'), 'こんにちは!');
  assert.equal(fs.readFileSync(path.join(recordingsDir, id, 'source.txt'), 'utf8'), '你好');
  assert.equal(fs.statSync(path.join(recordingsDir, id, 'translated.wav')).size, pcm.length + 44);
});

test('missing API key and invalid translation settings are rejected', async t => {
  const { wsBase } = await fixture(t);
  const dashboard = new WebSocket(wsBase + '/dashboard', { origin: 'http://localhost' });
  const next = messages(dashboard);
  await once(dashboard, 'open'); dashboard.send(JSON.stringify({ type: 'auth', token: dashboardToken }));
  const { settings } = await next(m => m.type === 'settings');
  dashboard.send(JSON.stringify({ type: 'settings', settings: { ...settings, enabled: true } }));
  assert.match((await next(m => m.type === 'error')).message, /OPENAI_API_KEY/);
  dashboard.send(JSON.stringify({ type: 'settings', settings: { ...settings, targetLanguage: '../../etc' } }));
  assert.match((await next(m => m.type === 'error')).message, /Invalid/);
});
