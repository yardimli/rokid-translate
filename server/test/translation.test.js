import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTranslationSession } from '../src/translation.js';

function setup() {
  const ws = new EventEmitter(); ws.readyState = 0; ws.bufferedAmount = 0;
  const sent = [], states = [], text = [], audio = [];
  ws.send = raw => sent.push(JSON.parse(raw)); ws.terminate = () => { ws.readyState = 3; ws.emit('close'); };
  ws.close = ws.terminate;
  const session = createTranslationSession({ apiKey: 'unused', settings: { sourceTranscript: true, noiseReduction: 'off', targetLanguage: 'en' },
    createSocket: () => ws, onState: s => states.push(s), onText: (...args) => text.push(args), onAudio: b => audio.push(b), onEvent() {} });
  const event = value => ws.emit('message', Buffer.from(JSON.stringify(value)));
  return { ws, sent, states, text, audio, session, event };
}
test('translation protocol configures, waits for acknowledgement, preserves deltas and drains on stop', () => {
  const f = setup(); f.ws.readyState = 1; f.ws.emit('open');
  assert.deepEqual(f.sent[0], { type: 'session.update', session: { audio: { input: { transcription: { model: 'gpt-realtime-whisper' }, noise_reduction: null }, output: { language: 'en' } } } });
  f.session.push(Buffer.from([1, 2])); assert.equal(f.sent.length, 1);
  f.event({ type: 'session.updated' }); assert.equal(f.sent[1].type, 'session.input_audio_buffer.append');
  assert.equal(f.sent[1].audio, 'AQI=');
  f.event({ type: 'session.output_transcript.delta', delta: 'Hi' });
  f.session.stop(); assert.equal(f.sent.at(-1).type, 'session.close'); assert.equal(f.ws.readyState, 1);
  f.session.push(Buffer.from([3, 4])); assert.equal(f.sent.at(-1).type, 'session.close');
  f.event({ type: 'session.output_transcript.delta', delta: ' there' });
  f.event({ type: 'session.output_audio.delta', delta: 'AQI=', sample_rate: 24000, channels: 1 });
  f.event({ type: 'session.closed' });
  assert.equal(f.text.map(t => t[1]).join(''), 'Hi there'); assert.equal(f.states.at(-1), 'stopped');
  assert.deepEqual(f.audio[0], Buffer.from([1, 2]));
});
test('startup queues and upstream backpressure are bounded', () => {
  const f = setup(); f.session.push(Buffer.alloc(96000)); f.session.push(Buffer.alloc(2));
  assert.equal(f.states.at(-1), 'error: startup_audio_queue_full');
  const g = setup(); g.ws.readyState = 1; g.event({ type: 'session.updated' }); g.ws.bufferedAmount = 128001;
  g.session.push(Buffer.alloc(2)); assert.equal(g.states.at(-1), 'error: upstream_backpressure');
});
test('upstream errors do not expose messages or credentials', () => {
  const f = setup(); f.event({ type: 'error', error: { code: 'invalid_api_key', message: 'private contents' } });
  assert.deepEqual(f.states, ['error: invalid_api_key']);
});
