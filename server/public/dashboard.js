const $ = id => document.getElementById(id);
let socket, events = [], deviceCache = [], authenticatedToken = '';
function status(text) { $('status').textContent = text; }
function renderEvents() { $('events').textContent = events.map(e => JSON.stringify(e)).join('\n'); $('events').scrollTop = $('events').scrollHeight; }
function renderDevices(devices) {
  deviceCache = devices;
  const selected = $('device').value; $('devices').replaceChildren(); $('device').replaceChildren();
  if (!devices.length) $('devices').textContent = 'No glasses connected. Open the app, configure its device token, then select Connect.';
  for (const d of devices) {
    const option = document.createElement('option'); option.value = d.id; option.textContent = `${d.name} · ${d.id.slice(0, 8)}`; $('device').append(option);
    const card = document.createElement('article');
    const title = document.createElement('strong'); title.textContent = `${d.name} · ${d.streaming ? 'Streaming' : 'Microphone idle'}`;
    const stats = document.createElement('p'); stats.className = 'stats'; stats.textContent = `${d.sampleRate || '—'} Hz / ${(d.bytes / 1024).toFixed(1)} KiB / ${d.chunks} chunks / level ${(d.rms * 100).toFixed(3)}% / peak ${((d.peakRms || 0) * 100).toFixed(3)}%`;
    const state = document.createElement('p'); state.textContent = `OpenAI: ${d.translationState || 'disabled'}${d.silentChunks >= 25 ? ' · Audio is all zeros: check glasses microphone / mute.' : ''}`;
    const meter = document.createElement('meter'); meter.min = 0; meter.max = 1; meter.value = d.rms;
    card.append(title, stats, meter, state); $('devices').append(card);
  }
  if (devices.some(d => d.id === selected)) $('device').value = selected;
  renderText();
}
function renderText() {
  const d = deviceCache.find(d => d.id === $('device').value);
  for (const kind of ['translation', 'source']) {
    const value = d?.[kind] || (kind === 'translation' ? 'Waiting for translation…' : 'Waiting for speech…');
    if ($(kind).textContent !== value) { $(kind).textContent = value; $(kind).scrollTop = $(kind).scrollHeight; }
  }
}
$('device').onchange = renderText;
function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) { status('Connect first.'); return; }
  socket.send(JSON.stringify(message));
}
function renderSettings(m) {
  $('language').replaceChildren(...Object.entries(m.languages).map(([code, name]) => {
    const option = document.createElement('option'); option.value = code; option.textContent = name; return option;
  }));
  $('language').value = m.settings.targetLanguage; $('noise').value = m.settings.noiseReduction;
  $('enabled').checked = m.settings.enabled; $('sourceTranscript').checked = m.settings.sourceTranscript;
  $('fontSize').value = m.settings.fontSize; $('captionChars').value = m.settings.captionChars;
  $('apiState').textContent = `${m.apiKeyConfigured ? 'OpenAI key configured' : 'OPENAI_API_KEY missing on server'} · ${m.settings.enabled ? 'Translation enabled' : 'Translation disabled'} · ${m.recordingEnabled ? 'Recording enabled' : 'Recording unavailable'}`;
}
function renderRecordings(recordings) {
  $('recordings').replaceChildren();
  if (!recordings.length) $('recordings').textContent = 'No saved sessions yet.';
  for (const r of recordings) {
    const card = document.createElement('article');
    const title = document.createElement('p'); title.textContent = `${new Date(r.startedAt).toLocaleString()} · ${r.name} → ${r.settings.targetLanguage} · ${r.complete ? (r.recordingError ? 'Recording error' : r.reason) : 'Recording / unfinished'}`;
    card.append(title);
    if (r.complete) for (const file of ['input.wav', 'translated.wav', 'source.txt', 'translation.txt', 'transcripts.jsonl', 'metadata.json']) {
      const button = document.createElement('button'); button.textContent = file; button.className = 'download';
      button.onclick = async () => {
        button.disabled = true;
        try {
          const response = await fetch(`/api/recordings/${r.id}/${file}`, { headers: { Authorization: `Bearer ${authenticatedToken}` } });
          if (!response.ok) throw new Error(`Download failed (${response.status})`);
          const url = URL.createObjectURL(await response.blob());
          const link = document.createElement('a'); link.href = url; link.download = `${r.id}-${file}`; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) { status(error.message); } finally { button.disabled = false; }
      }; card.append(button);
    }
    $('recordings').append(card);
  }
}
$('apply').onclick = () => send({ type: 'settings', settings: {
  enabled: $('enabled').checked, targetLanguage: $('language').value, noiseReduction: $('noise').value,
  sourceTranscript: $('sourceTranscript').checked, fontSize: Number($('fontSize').value), captionChars: Number($('captionChars').value)
} });
$('refreshRecordings').onclick = () => send({ type: 'recordings' });
$('connect').onclick = () => {
  socket?.close();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/dashboard`); socket = ws;
  status('Connecting…');
  const token = $('token').value.trim();
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.onmessage = event => {
    if (socket !== ws) return;
    const m = JSON.parse(event.data);
    if (m.type === 'snapshot') { authenticatedToken = token; status('Connected'); events = m.events; renderDevices(m.devices); renderEvents(); }
    if (m.type === 'settings') { renderSettings(m); status('Connected · settings loaded'); }
    if (m.type === 'recordings') renderRecordings(m.recordings);
    if (m.type === 'transcript') { const d = deviceCache.find(d => d.id === m.deviceId); if (d) d[m.kind] = m.text; renderText(); }
    if (m.type === 'metrics') renderDevices(m.devices);
    if (m.type === 'event') { events.push(m.event); events = events.slice(-500); renderEvents(); }
    if (m.type === 'error') status(m.message);
  };
  ws.onclose = e => { if (socket === ws) { status(`Disconnected (${e.code})${e.reason ? ': ' + e.reason : ''}`); renderDevices([]); } };
  ws.onerror = () => { if (socket === ws) status('Connection failed; check Apache, SSL and server logs.'); };
};
$('disconnect').onclick = () => socket?.close();
$('send').onclick = () => {
  if (socket?.readyState !== WebSocket.OPEN) { status('Connect first.'); return; }
  socket.send(JSON.stringify({ type: 'caption', deviceId: $('device').value, text: $('caption').value }));
};
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([events.map(e => JSON.stringify(e)).join('\n')], { type: 'application/x-ndjson' }));
  const link = document.createElement('a'); link.href = url; link.download = 'rokid-events.jsonl'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
