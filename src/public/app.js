'use strict';

/**
 * Dashboard Smart Door KOS — klien statis murni (tanpa build step).
 *
 * Semua request ke /api/* menyertakan header `x-api-key`. Live feed (/api/feed)
 * memakai fetch streaming (bukan EventSource) agar header API key bisa dikirim,
 * lalu frame SSE (event:/data:) diparse manual.
 */

const API_KEY_STORAGE = 'smartdoor_api_key';

const el = (id) => document.getElementById(id);
const apiKeyInput = el('apiKey');

/** Ambil API key aktif dari input. */
function apiKey() {
  return apiKeyInput.value.trim();
}

/** Tampilkan notifikasi singkat. */
function toast(message, ok = true) {
  const t = el('toast');
  t.textContent = message;
  t.className = 'toast ' + (ok ? 'ok' : 'err');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

/** Wrapper fetch dengan header API key + penanganan error seragam. */
async function api(path, options = {}) {
  const key = apiKey();
  if (!key) {
    throw new Error('API Key belum diisi');
  }
  const res = await fetch(path, {
    ...options,
    headers: {
      'x-api-key': key,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/* ---------------------------------------------------------------- Rendering */

function badge(status) {
  return `<span class="badge badge-${status}">${status}</span>`;
}

function renderCards(rows) {
  const body = el('cardsBody');
  if (!rows || rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Belum ada kartu</td></tr>';
    el('statCardsActive').textContent = '0';
    return;
  }
  const active = rows.filter((c) => c.status === 'ACTIVE').length;
  el('statCardsActive').textContent = String(active);
  body.innerHTML = rows.map((c) => {
    const exp = c.expired_at ? new Date(c.expired_at).toLocaleString('id-ID') : '—';
    const canRevoke = c.status !== 'REVOKED';
    return `<tr>
      <td class="mono">${c.uid}</td>
      <td>${c.user_id ?? '—'}</td>
      <td>${c.room_id ?? '—'}</td>
      <td>${badge(c.status)}</td>
      <td>${exp}</td>
      <td>${canRevoke ? `<button class="btn-danger" data-revoke="${c.uid}">Revoke</button>` : ''}</td>
    </tr>`;
  }).join('');
}

function renderDevices(rows) {
  const body = el('devicesBody');
  if (!rows || rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Belum ada device</td></tr>';
    el('statDevicesOnline').textContent = '0';
    return;
  }
  const online = rows.filter((d) => d.status === 'ONLINE').length;
  el('statDevicesOnline').textContent = String(online);
  body.innerHTML = rows.map((d) => `<tr>
      <td class="mono">${d.device_id}</td>
      <td>${d.room_id ?? '—'}</td>
      <td>${badge(d.status)}</td>
      <td>${d.rssi ?? '—'}</td>
      <td>${d.db_version ?? '—'}</td>
      <td><button class="btn-unlock" data-unlock="${d.device_id}">Unlock</button></td>
    </tr>`).join('');
}

function renderResidents(rows) {
  const list = el('residentsList');
  el('statResidents').textContent = String(rows ? rows.length : 0);
  list.innerHTML = (rows && rows.length)
    ? rows.map((r) => `<li><span class="idtag">#${r.id}</span>${r.name}${r.phone ? ` · ${r.phone}` : ''} ${badge(r.status)}</li>`).join('')
    : '<li class="empty">Belum ada penghuni</li>';
}

function renderRooms(rows) {
  const list = el('roomsList');
  el('statRooms').textContent = String(rows ? rows.length : 0);
  list.innerHTML = (rows && rows.length)
    ? rows.map((r) => `<li><span class="idtag">#${r.id}</span>${r.room_no}${r.device_id ? ` → ${r.device_id}` : ''}</li>`).join('')
    : '<li class="empty">Belum ada kamar</li>';
}

/* ------------------------------------------------------------------- Loaders */

async function loadCards() {
  try { renderCards(await api('/api/cards')); }
  catch (e) { toast('Gagal memuat kartu: ' + e.message, false); }
}
async function loadDevices() {
  try { renderDevices(await api('/api/devices')); }
  catch (e) { toast('Gagal memuat device: ' + e.message, false); }
}
async function loadPeople() {
  try {
    const [residents, rooms] = await Promise.all([api('/api/residents'), api('/api/rooms')]);
    renderResidents(residents);
    renderRooms(rooms);
  } catch (e) { toast('Gagal memuat data: ' + e.message, false); }
}
async function loadAll() {
  await Promise.all([loadCards(), loadDevices(), loadPeople()]);
}

/* -------------------------------------------------------------------- Actions */

el('formResident').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const payload = { name: f.name.value.trim() };
  if (f.phone.value.trim()) payload.phone = f.phone.value.trim();
  try {
    const r = await api('/api/residents', { method: 'POST', body: JSON.stringify(payload) });
    toast(`Penghuni dibuat (id ${r.id})`);
    f.reset();
    loadPeople();
  } catch (e) { toast('Gagal: ' + e.message, false); }
});

el('formRoom').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const payload = { room_no: f.room_no.value.trim() };
  if (f.device_id.value.trim()) payload.device_id = f.device_id.value.trim();
  try {
    const r = await api('/api/rooms', { method: 'POST', body: JSON.stringify(payload) });
    toast(`Kamar dibuat (id ${r.id})`);
    f.reset();
    loadPeople();
  } catch (e) { toast('Gagal: ' + e.message, false); }
});

el('formProvision').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const payload = {
    uid: f.uid.value.trim(),
    resident_id: Number(f.resident_id.value),
    room_id: Number(f.room_id.value),
  };
  if (f.expired_at.value) {
    // datetime-local → ISO-8601 UTC
    payload.expired_at = new Date(f.expired_at.value).toISOString();
  }
  try {
    const r = await api('/api/provisioning', { method: 'POST', body: JSON.stringify(payload) });
    toast(`Provisioning OK: ${r.uid || payload.uid} → ACTIVE`);
    f.reset();
    loadCards();
  } catch (e) { toast('Provisioning gagal: ' + e.message, false); }
});

// Delegasi tombol revoke (tabel kartu) & unlock (tabel device).
document.addEventListener('click', async (ev) => {
  const revoke = ev.target.closest('[data-revoke]');
  const unlock = ev.target.closest('[data-unlock]');
  if (revoke) {
    const uid = revoke.getAttribute('data-revoke');
    if (!confirm(`Cabut (revoke) kartu ${uid}? Tindakan ini permanen.`)) return;
    try {
      await api(`/api/cards/${encodeURIComponent(uid)}/revoke`, { method: 'POST' });
      toast(`Kartu ${uid} di-revoke`);
      loadCards();
    } catch (e) { toast('Revoke gagal: ' + e.message, false); }
  } else if (unlock) {
    const dev = unlock.getAttribute('data-unlock');
    try {
      const r = await api(`/api/devices/${encodeURIComponent(dev)}/unlock`, { method: 'POST' });
      toast(`Perintah unlock dikirim ke ${dev} (nonce ${String(r.nonce).slice(0, 8)}…)`);
    } catch (e) { toast('Unlock gagal: ' + e.message, false); }
  }
});

el('refreshCards').addEventListener('click', loadCards);
el('refreshDevices').addEventListener('click', loadDevices);
el('refreshPeople').addEventListener('click', loadPeople);

/* ---------------------------------------------------------------- Live feed */

let feedController = null;

function pushFeed(kind, label, obj) {
  const feed = el('feed');
  const placeholder = feed.querySelector('.empty');
  if (placeholder) placeholder.remove();
  const item = document.createElement('div');
  item.className = 'feed-item ' + kind;
  const time = new Date().toLocaleTimeString('id-ID');
  item.innerHTML = `<div><b>${label}</b></div><div class="meta">${time} · ${escapeHtml(JSON.stringify(obj))}</div>`;
  feed.prepend(item);
  while (feed.children.length > 60) feed.removeChild(feed.lastChild);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** Parse buffer SSE menjadi event {event, data}. */
function parseSseChunk(buffer, onEvent) {
  let idx;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    let name = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      // baris komentar (diawali ':') diabaikan
    }
    if (dataLines.length) {
      let data = dataLines.join('\n');
      try { data = JSON.parse(data); } catch (_) { /* biarkan string */ }
      onEvent(name, data);
    }
  }
  return buffer;
}

async function connectFeed() {
  const key = apiKey();
  if (!key) return;
  // Hentikan koneksi lama bila ada.
  if (feedController) feedController.abort();
  feedController = new AbortController();

  try {
    const res = await fetch('/api/feed', {
      headers: { 'x-api-key': key, Accept: 'text/event-stream' },
      signal: feedController.signal,
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);

    setFeedState(true);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseChunk(buffer, (name, data) => {
        if (name === 'access') {
          const kind = data && data.result === 'GRANT' ? 'grant' : 'deny';
          pushFeed(kind, `Akses ${data.result || ''} · ${data.device_id || ''}`, data);
          loadCards();
        } else if (name === 'alert') {
          pushFeed('alert', `⚠ ALERT ${data.type || ''} · ${data.device_id || ''}`, data);
        }
      });
    }
    setFeedState(false);
  } catch (e) {
    if (e.name !== 'AbortError') {
      setFeedState(false);
      toast('Live feed terputus: ' + e.message, false);
    }
  }
}

function setFeedState(on) {
  const s = el('feedState');
  s.textContent = on ? 'SSE live' : 'SSE off';
  s.className = 'pill ' + (on ? 'pill-on' : 'pill-off');
}

function setConnState(on) {
  const s = el('connState');
  s.textContent = on ? 'Terhubung' : 'Belum terhubung';
  s.className = 'pill ' + (on ? 'pill-on' : 'pill-off');
}

/* ---------------------------------------------------------------- Bootstrap */

el('saveKey').addEventListener('click', async () => {
  const key = apiKey();
  if (!key) { toast('Isi API Key dulu', false); return; }
  localStorage.setItem(API_KEY_STORAGE, key);
  try {
    await api('/api/residents'); // uji validitas key
    setConnState(true);
    toast('API Key tersimpan & valid');
    await loadAll();
    connectFeed();
  } catch (e) {
    setConnState(false);
    toast('Key ditolak: ' + e.message, false);
  }
});

// Muat key tersimpan saat halaman dibuka.
(function init() {
  const saved = localStorage.getItem(API_KEY_STORAGE);
  if (saved) {
    apiKeyInput.value = saved;
    el('saveKey').click();
  }
})();
