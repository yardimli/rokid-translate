import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const recordingFiles = ['input.wav', 'translated.wav', 'transcripts.jsonl', 'source.txt', 'translation.txt', 'metadata.json'];
function wavHeader(bytes) {
  const b = Buffer.alloc(44);
  b.write('RIFF'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
export function createRecording(root, metadata, onError) {
  const id = randomUUID(), dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const info = { id, startedAt: new Date().toISOString(), ...metadata, complete: false };
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(info, null, 2));
  let closed = false, failed = false;
  const counts = { input: 0, translated: 0 };
  const streams = {};
  function fail() { if (!failed) { failed = true; onError(); } }
  for (const name of ['input', 'translated', 'transcripts', 'source', 'translation']) {
    const file = name === 'transcripts' ? 'transcripts.jsonl' : `${name}.${name === 'source' || name === 'translation' ? 'txt' : 'wav'}`;
    streams[name] = fs.createWriteStream(path.join(dir, file));
    streams[name].on('error', fail);
    if (name === 'input' || name === 'translated') streams[name].write(wavHeader(0));
  }
  return {
    id,
    audio(kind, pcm) {
      if (closed || failed) return;
      if (counts[kind] + pcm.length > 256 * 1024 * 1024 || streams[kind].writableLength > 2 * 1024 * 1024) { fail(); return; }
      counts[kind] += pcm.length; streams[kind].write(pcm);
    },
    text(kind, delta, elapsedMs) {
      if (!closed && !failed) {
        if (streams.transcripts.writableLength > 1024 * 1024 || streams[kind].writableLength > 1024 * 1024) { fail(); return; }
        streams.transcripts.write(JSON.stringify({ time: new Date().toISOString(), kind, delta, elapsedMs }) + '\n');
        streams[kind].write(delta);
      }
    },
    async close(reason) {
      if (closed) return; closed = true;
      await Promise.all(Object.values(streams).map(s => new Promise(resolve => {
        if (s.destroyed || s.closed) resolve();
        else { s.once('close', resolve); s.end(); }
      })));
      try {
        for (const kind of ['input', 'translated']) {
          const file = path.join(dir, `${kind}.wav`);
          const bytes = Math.max(0, fs.statSync(file).size - 44);
          const fd = fs.openSync(file, 'r+');
          try { fs.writeSync(fd, wavHeader(bytes), 0, 44, 0); } finally { fs.closeSync(fd); }
        }
        fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ ...info, complete: true, recordingError: failed,
          endedAt: new Date().toISOString(), reason, bytes: counts }, null, 2));
      } catch { fail(); }
    }
  };
}

export function listRecordings(root) {
  if (!root || !fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(id => /^[a-f0-9-]{36}$/.test(id)).flatMap(id => {
    try { return [JSON.parse(fs.readFileSync(path.join(root, id, 'metadata.json'), 'utf8'))]; } catch { return []; }
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100);
}
