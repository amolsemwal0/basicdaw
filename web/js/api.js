// Thin client for the BasicDAW server's REST API.

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new Error('The BasicDAW server is not reachable - is server.py running?');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  health: () => req('GET', '/api/health'),

  listProjects: () => req('GET', '/api/projects').then((r) => r.projects),
  getProject: (id) => req('GET', `/api/projects/${enc(id)}`),
  createProject: (name, project) => req('POST', '/api/projects', { name, project }),
  saveProject: (id, project) => req('PUT', `/api/projects/${enc(id)}`, project),
  deleteProject: (id) => req('DELETE', `/api/projects/${enc(id)}`),
  renameProject: (id, name) => req('POST', `/api/projects/${enc(id)}/rename`, { name }),
  duplicateProject: (id, name) => req('POST', `/api/projects/${enc(id)}/duplicate`, { name }),
  audioUrl: (id, file) => `/api/projects/${enc(id)}/audio/${enc(file)}`,
  async uploadAudio(id, file, name = file.name) {
    const res = await fetch(`/api/projects/${enc(id)}/audio/${enc(name)}`, { method: 'PUT', body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    return data;
  },

  cache: () => req('GET', '/api/cache'),
  clearCache: () => req('DELETE', '/api/cache'),

  midiStatus: () => req('GET', '/api/midi/status'),
  midiInputs: (wanted) => req('POST', '/api/midi/inputs', { wanted }),
  midiSend: (port, events) => req('POST', '/api/midi/send', { port, events }),
  midiFlush: () => req('POST', '/api/midi/flush', {}),
  midiClock: (action, bpm, ports, clock = true) => req('POST', '/api/midi/clock', { action, bpm, ports, clock }),

  midinousStatus: () => req('GET', '/api/midinous/status'),
  midinousFiles: () => req('GET', '/api/midinous/files'),
  async midinousMidi(name, source) {
    const res = await fetch(`/api/midinous/midi?name=${enc(name)}&source=${enc(source)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not read MIDI file');
    return res.arrayBuffer();
  },
  midinousRender: (payload) => req('POST', '/api/midinous/render', payload),
  midinousExport: (payload) => req('POST', '/api/midinous/export', payload),

  /** Saves a file through the server (the Android app's Download folder); resolves with where it went. */
  async saveExport(blob, name) {
    const res = await fetch(`/api/exports?name=${enc(name)}&type=${enc(blob.type)}`, { method: 'POST', body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Could not save ${name} (${res.status})`);
    return data.saved;
  },
  exportFormats: () => req('GET', '/api/export/formats'),
  exportProgress: (job) => req('GET', `/api/export/progress?job=${enc(job)}`).then((r) => r.progress),
  /** Encodes a mixdown WAV with ffmpeg (FLAC, MP3, OGG, Opus, M4A). */
  async encode(options, body) {
    const query = new URLSearchParams(Object.entries(options).filter(([, v]) => v !== undefined && v !== ''));
    let res;
    try {
      res = await fetch(`/api/export/encode?${query}`, { method: 'POST', body });
    } catch {
      throw new Error('The BasicDAW server is not reachable - is server.py running?');
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Encoding failed (${res.status})`);
    return res.blob();
  },
};
