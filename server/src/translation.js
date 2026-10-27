import { WebSocket } from 'ws';

// Dedicated translation protocol, not the conversational Realtime API.
export function createTranslationSession({ apiKey, settings, onState, onText, onAudio, onEvent,
  createSocket = () => new WebSocket('wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate', {
    headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024
  }) }) {
  const ws = createSocket();
  let ready = false, stopping = false, ended = false, queue = [], queuedBytes = 0;
  let closeTimer;
  const startupTimer = setTimeout(() => fail('startup_timeout'), 12000);
  function finish(state) {
    if (ended) return;
    ended = true; clearTimeout(startupTimer); clearTimeout(closeTimer); queue = [];
    onState(state);
  }
  function fail(code) { finish(`error: ${code}`); ws.terminate(); }
  function send(value) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > 128000) { fail('upstream_backpressure'); return false; }
    ws.send(JSON.stringify(value)); return true;
  }
  function append(pcm) { return send({ type: 'session.input_audio_buffer.append', audio: pcm.toString('base64') }); }
  function closeSession() {
    send({ type: 'session.close' });
    closeTimer = setTimeout(() => fail('drain_timeout'), 15000);
  }
  ws.on('open', () => send({ type: 'session.update', session: { audio: {
    input: { transcription: settings.sourceTranscript ? { model: 'gpt-realtime-whisper' } : null,
      noise_reduction: settings.noiseReduction === 'off' ? null : { type: settings.noiseReduction } },
    output: { language: settings.targetLanguage }
  } } }));
  ws.on('message', raw => {
    if (ended) return;
    try {
      const event = JSON.parse(raw.toString());
      if (event.type === 'session.updated' && !ready) {
        ready = true; clearTimeout(startupTimer); onState(stopping ? 'finishing' : 'translating');
        for (const pcm of queue) { if (!append(pcm)) break; }
        queue = []; queuedBytes = 0;
        if (stopping && !ended) closeSession();
      } else if (event.type === 'session.output_transcript.delta' || event.type === 'session.input_transcript.delta') {
        if (typeof event.delta === 'string') onText(event.type.includes('output_') ? 'translation' : 'source', event.delta, event.elapsed_ms);
      } else if (event.type === 'session.output_audio.delta') {
        if ((event.sample_rate && event.sample_rate !== 24000) || (event.channels && event.channels !== 1)) { fail('unsupported_output_audio'); return; }
        onAudio(Buffer.from(event.delta, 'base64'));
      } else if (event.type === 'error') {
        // Error messages may echo request data. Retain only a sanitized code.
        const code = String(event.error?.code || event.error?.type || 'api_error').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
        fail(code);
      } else if (event.type === 'session.closed') {
        onEvent('session_closed'); finish(stopping ? 'stopped' : 'error: upstream_session_closed'); ws.close();
      }
    } catch { fail('invalid_upstream_event'); }
  });
  ws.on('unexpected-response', (request, response) => {
    response.resume(); fail(`http_${response.statusCode}`); request.destroy();
  });
  ws.on('error', () => fail('connection_failed'));
  ws.on('close', () => finish('error: upstream_disconnected'));
  return {
    push(pcm) {
      if (stopping || ended) return;
      if (ready) append(pcm);
      else if (queuedBytes + pcm.length <= 96000) { queue.push(Buffer.from(pcm)); queuedBytes += pcm.length; }
      else fail('startup_audio_queue_full');
    },
    stop() { if (ended || stopping) return; stopping = true; onState('finishing'); if (ready) closeSession(); },
    abort() { finish('stopped'); ws.terminate(); }
  };
}
