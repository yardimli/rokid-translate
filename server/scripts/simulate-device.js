// Synthetic PCM only: useful before the APK is installed. No microphone is opened.
import { WebSocket } from 'ws';
const base = process.env.SERVER_URL || 'http://127.0.0.1:8787';
if (!process.env.DEVICE_TOKEN) throw new Error('Set DEVICE_TOKEN or run with --env-file=.env');
const url = new URL('/device', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
let timer, phase = 0;
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', name: 'SIMULATED glasses (synthetic tone)', appVersion: 'simulator-1' }));
  ws.send(JSON.stringify({ type: 'stream_start', sampleRate: 24000, channels: 1, format: 'pcm16le' }));
  timer = setInterval(() => {
    const audio = Buffer.alloc(9600);
    for (let i = 0; i < 4800; i++) audio.writeInt16LE(Math.round(Math.sin(phase++ * 2 * Math.PI * 440 / 24000) * 8000), i * 2);
    if (ws.readyState === WebSocket.OPEN) ws.send(audio);
  }, 200);
  console.log('Synthetic audio streaming. Ctrl+C to stop.');
});
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'caption') {
    console.log('Caption received:', m.text);
    ws.send(JSON.stringify({ type: 'caption_ack', captionId: m.captionId }));
  }
});
ws.on('error', e => { console.error(e.message); process.exitCode = 1; });
ws.on('close', () => { clearInterval(timer); console.log('Simulator disconnected.'); });
process.on('SIGINT', () => { clearInterval(timer); ws.close(); });
