'use strict';

/**
 * Live Access Feed — SSE Hub — Smart Door KOS ESP32 (Web Server Node.js).
 *
 * Hub real-time yang mem-broadcast kejadian akses (log) dan alert keamanan
 * (tamper/brute-force) ke klien dashboard. Transport default adalah
 * **Server-Sent Events (SSE)** (`text/event-stream`) sesuai design.md
 * ("Live Access Feed & Audit Trail", Req 14). WebSocket bersifat OPSIONAL dan
 * diekspos sebagai jalur broadcast tambahan (lihat `addWebSocket`), namun SSE
 * yang diwajibkan.
 *
 * Model (lihat design.md "Live Access Feed & Audit Trail", Req 14, Req 13.3):
 *   - Hub menyimpan himpunan klien yang SEDANG terhubung (in-memory `Set`).
 *   - `broadcast(eventName, data)` menulis frame SSE
 *       `event: <name>\n` + `data: <json>\n\n`
 *     ke SEMUA klien yang terhubung saat itu.
 *   - Konsumer MQTT & `auditTrail` memanggil helper `publishAccessLog(...)` /
 *     `publishAlert(...)` agar setiap log/alert ter-broadcast real-time
 *     (Req 14.1 live feed; Req 13.3 alert merah tamper/brute-force).
 *
 * PENTING — semantik kehilangan event saat terputus (Req 14.2):
 *   Hub HANYA mem-broadcast ke klien yang sedang terhubung. Event yang terjadi
 *   SELAGI koneksi SSE/WebSocket klien terputus DIANGGAP HILANG dari live feed:
 *   hub TIDAK mem-buffer maupun memutar-ulang (replay) event yang terlewat saat
 *   klien terhubung kembali. Ketentuan ini hanya mengatur live feed; persistensi
 *   audit trail pada tabel `access_logs` terpisah dan tidak terpengaruh
 *   (lihat `auditTrail.js`).
 *
 * Nama event SSE yang dipakai (field `event:`):
 *   - `access`     — kejadian akses (GRANT/DENY) untuk live access feed (Req 14.1).
 *   - `alert`      — alert keamanan tamper/brute-force, ditampilkan merah (Req 13.3).
 *
 * Desain agar mudah diuji:
 *   - Hub menerima objek response "palsu" (fake) yang hanya perlu menyediakan
 *     `write()`, `end()`, dan `on()` (serta `writeHead()`/`flushHeaders()` yang
 *     opsional). Dengan begitu uji dapat mendaftarkan klien palsu, memanggil
 *     `broadcast(...)`, lalu meng-assert frame SSE yang tertulis; dan meng-assert
 *     bahwa klien yang sudah dihapus TIDAK menerima apa pun setelahnya.
 *   - Timer heartbeat memakai `setInterval` yang di-`unref()` bila tersedia agar
 *     tidak menahan proses tetap hidup; dapat dinonaktifkan via opsi
 *     `heartbeatIntervalMs: 0` (berguna untuk uji deterministik).
 *
 * _Requirements: 14.1, 13.3_
 */

/** Nama event SSE untuk kejadian akses (live access feed). Req 14.1. */
const EVENT_ACCESS = 'access';

/** Nama event SSE untuk alert keamanan (tamper/brute-force). Req 13.3. */
const EVENT_ALERT = 'alert';

/** Interval heartbeat/ping default (ms) untuk menjaga koneksi SSE tetap hidup. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25000;

/**
 * Serialisasi sebuah frame SSE sesuai spesifikasi `text/event-stream`.
 * Menghasilkan string: `event: <name>\n` diikuti satu baris `data:` berisi
 * JSON `payload`, diakhiri baris kosong (`\n\n`) sebagai batas event.
 *
 * Catatan: payload di-stringify sebagai JSON satu baris. Jika suatu saat
 * payload mengandung newline, fungsi ini memecahnya menjadi beberapa baris
 * `data:` agar tetap valid SSE.
 *
 * @param {string} eventName nama event (field `event:`).
 * @param {*} payload data yang akan di-JSON-kan pada field `data:`.
 * @returns {string} frame SSE lengkap.
 */
function formatSseFrame(eventName, payload) {
  const json = JSON.stringify(payload === undefined ? null : payload);
  const dataLines = json.split('\n').map((line) => `data: ${line}`).join('\n');
  return `event: ${eventName}\n${dataLines}\n\n`;
}

/**
 * Hub SSE untuk live access feed.
 *
 * Mengelola himpunan klien yang terhubung dan menyediakan broadcast ke semua
 * klien. Lihat dokumentasi modul untuk semantik Req 14.2 (tanpa replay).
 */
class LiveFeedHub {
  /**
   * @param {object} [options]
   * @param {number} [options.heartbeatIntervalMs] interval ping komentar SSE
   *   dalam ms; `0` menonaktifkan heartbeat (berguna untuk uji). Default 25000.
   */
  constructor(options = {}) {
    const { heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS } = options;

    /**
     * Klien SSE yang terhubung. Tiap entri adalah objek response (asli atau
     * palsu) yang mendukung `write()`/`end()`/`on()`.
     * @type {Set<object>}
     * @private
     */
    this._clients = new Set();

    /**
     * Klien WebSocket OPSIONAL yang terhubung. Tiap entri mendukung `send()`
     * dan (opsional) `on('close', ...)`. SSE adalah default; ini jalur tambahan.
     * @type {Set<object>}
     * @private
     */
    this._wsClients = new Set();

    /** @private */
    this._heartbeatIntervalMs = heartbeatIntervalMs;

    /** @private */
    this._heartbeatTimer = null;
  }

  /**
   * Jumlah klien yang sedang terhubung (SSE + WebSocket). Berguna untuk uji
   * dan telemetri.
   * @returns {number}
   */
  get clientCount() {
    return this._clients.size + this._wsClients.size;
  }

  /**
   * Daftarkan sebuah koneksi SSE baru.
   *
   * Menyetel header `text/event-stream` (no-cache, keep-alive), mengirim satu
   * komentar awal agar koneksi segera "mengalir", lalu menambahkan `res` ke
   * himpunan klien. Klien otomatis dihapus saat event `'close'` terpicu pada
   * `req` (atau `res` bila `req` tidak menyediakan `on`).
   *
   * Objek `res` cukup menyediakan `write()` dan `end()`; `writeHead()` dan
   * `flushHeaders()` dipakai bila ada. Objek `req` cukup menyediakan `on()`.
   *
   * @param {object} req request HTTP (atau palsu dengan `on`).
   * @param {object} res response HTTP (atau palsu dengan `write`/`end`[/`writeHead`]).
   * @returns {object} `res` (untuk chaining/uji).
   */
  addClient(req, res) {
    if (!res || typeof res.write !== 'function') {
      throw new TypeError('addClient: res harus menyediakan write()');
    }

    // Set header SSE standar. writeHead() dipakai bila tersedia; jika tidak,
    // coba setHeader() (keduanya opsional untuk mendukung response palsu).
    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nonaktifkan buffering proxy (mis. nginx) agar event langsung terkirim.
      'X-Accel-Buffering': 'no',
    };
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, headers);
    } else if (typeof res.setHeader === 'function') {
      for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
      }
    }
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    // Komentar awal: "mengalirkan" koneksi dan menandai hub siap. Baris diawali
    // ':' adalah komentar SSE (diabaikan klien) sesuai spesifikasi.
    res.write(': connected\n\n');

    this._clients.add(res);

    // Hapus klien pada 'close'. Prefer sinyal dari req (koneksi putus); jika
    // req tak menyediakan on(), pasang pada res sebagai cadangan.
    const onClose = () => this.removeClient(res);
    if (req && typeof req.on === 'function') {
      req.on('close', onClose);
    } else if (typeof res.on === 'function') {
      res.on('close', onClose);
    }

    this._ensureHeartbeat();
    return res;
  }

  /**
   * Hapus sebuah klien SSE dari hub. Idempoten (aman dipanggil berkali-kali).
   * Setelah dihapus, klien TIDAK akan menerima broadcast berikutnya (Req 14.2).
   *
   * @param {object} res response yang akan dilepas.
   * @returns {boolean} true bila klien ada dan terhapus; false bila tidak ada.
   */
  removeClient(res) {
    const removed = this._clients.delete(res);
    if (removed && typeof res.end === 'function') {
      try {
        res.end();
      } catch (_err) {
        // Abaikan error saat menutup koneksi yang mungkin sudah tertutup.
      }
    }
    this._maybeStopHeartbeat();
    return removed;
  }

  /**
   * Daftarkan koneksi WebSocket OPSIONAL. SSE adalah default; ini jalur dua
   * arah tambahan. Klien WS cukup menyediakan `send()`; bila ada `on('close')`
   * ia dihapus otomatis saat tertutup.
   *
   * @param {object} ws objek WebSocket (atau palsu dengan `send`).
   * @returns {object} `ws`.
   */
  addWebSocket(ws) {
    if (!ws || typeof ws.send !== 'function') {
      throw new TypeError('addWebSocket: ws harus menyediakan send()');
    }
    this._wsClients.add(ws);
    if (typeof ws.on === 'function') {
      ws.on('close', () => this.removeWebSocket(ws));
    }
    return ws;
  }

  /**
   * Hapus sebuah klien WebSocket dari hub. Idempoten.
   * @param {object} ws objek WebSocket.
   * @returns {boolean} true bila ada dan terhapus.
   */
  removeWebSocket(ws) {
    return this._wsClients.delete(ws);
  }

  /**
   * Broadcast sebuah event ke SEMUA klien yang sedang terhubung (SSE + WS).
   *
   * Untuk SSE: menulis frame `event: <name>\n` + `data: <json>\n\n`.
   * Untuk WS: mengirim JSON `{ event, data }`.
   *
   * Hanya klien yang terhubung saat ini yang menerima; tidak ada buffering /
   * replay untuk klien yang terputus (Req 14.2). Klien yang gagal ditulisi
   * (koneksi mati) otomatis dihapus agar hub tidak bocor.
   *
   * @param {string} eventName nama event SSE (mis. 'access' | 'alert').
   * @param {*} data payload event (akan di-JSON-kan).
   * @returns {number} jumlah klien yang berhasil menerima broadcast.
   */
  broadcast(eventName, data) {
    if (typeof eventName !== 'string' || eventName.length === 0) {
      throw new TypeError('broadcast: eventName wajib berupa string non-kosong');
    }

    let delivered = 0;
    const frame = formatSseFrame(eventName, data);

    // SSE clients.
    for (const res of Array.from(this._clients)) {
      try {
        res.write(frame);
        delivered += 1;
      } catch (_err) {
        // Koneksi mati — lepaskan klien agar tidak terus mencoba.
        this.removeClient(res);
      }
    }

    // WebSocket clients (opsional).
    const wsPayload = JSON.stringify({ event: eventName, data: data === undefined ? null : data });
    for (const ws of Array.from(this._wsClients)) {
      try {
        ws.send(wsPayload);
        delivered += 1;
      } catch (_err) {
        this.removeWebSocket(ws);
      }
    }

    return delivered;
  }

  /**
   * Broadcast kejadian akses (GRANT/DENY) ke live access feed (Req 14.1).
   * Dipanggil oleh konsumer log MQTT / `auditTrail` setelah log diterima.
   *
   * @param {object} log kejadian akses, mis.
   *   `{ device_id, uid, result, ts, sync_type }`.
   * @returns {number} jumlah klien yang menerima.
   */
  publishAccessLog(log) {
    return this.broadcast(EVENT_ACCESS, log);
  }

  /**
   * Broadcast alert keamanan (tamper / brute-force) agar dashboard menampilkan
   * alert merah untuk pintu terkait (Req 13.3).
   *
   * @param {object} alert alert, mis. `{ device_id, type:'tamper'|'bruteforce', ts, ... }`.
   * @returns {number} jumlah klien yang menerima.
   */
  publishAlert(alert) {
    return this.broadcast(EVENT_ALERT, alert);
  }

  /**
   * Express handler untuk `GET /api/feed`. Mendaftarkan koneksi sebagai klien
   * SSE. Pasang di `app.js`: `app.get('/api/feed', apiKey, hub.handler())`.
   *
   * @returns {(req: object, res: object) => void} handler Express.
   */
  handler() {
    return (req, res) => {
      this.addClient(req, res);
    };
  }

  /**
   * Tutup seluruh koneksi dan hentikan heartbeat. Berguna untuk shutdown
   * bersih / pembersihan pada uji.
   * @returns {void}
   */
  close() {
    for (const res of Array.from(this._clients)) {
      this.removeClient(res);
    }
    for (const ws of Array.from(this._wsClients)) {
      if (typeof ws.close === 'function') {
        try {
          ws.close();
        } catch (_err) {
          /* abaikan */
        }
      }
      this.removeWebSocket(ws);
    }
    this._stopHeartbeat();
  }

  /**
   * Pastikan timer heartbeat aktif bila ada klien & interval > 0.
   * Heartbeat mengirim komentar SSE ':ping' periodik untuk menjaga koneksi &
   * mendeteksi putus.
   * @private
   */
  _ensureHeartbeat() {
    if (this._heartbeatTimer || this._heartbeatIntervalMs <= 0) {
      return;
    }
    if (this._clients.size === 0) {
      return;
    }
    this._heartbeatTimer = setInterval(() => {
      for (const res of Array.from(this._clients)) {
        try {
          res.write(': ping\n\n');
        } catch (_err) {
          this.removeClient(res);
        }
      }
    }, this._heartbeatIntervalMs);
    // Jangan tahan event loop hanya karena timer heartbeat.
    if (typeof this._heartbeatTimer.unref === 'function') {
      this._heartbeatTimer.unref();
    }
  }

  /**
   * Hentikan heartbeat bila sudah tidak ada klien SSE.
   * @private
   */
  _maybeStopHeartbeat() {
    if (this._clients.size === 0) {
      this._stopHeartbeat();
    }
  }

  /** @private */
  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }
}

/**
 * Instance hub bersama (singleton) yang dipakai lintas modul (app.js,
 * konsumer MQTT, auditTrail). Konsumer cukup `require` modul ini dan memanggil
 * `hub.publishAccessLog(...)` / `hub.publishAlert(...)`.
 */
const hub = new LiveFeedHub();

module.exports = {
  LiveFeedHub,
  hub,
  formatSseFrame,
  EVENT_ACCESS,
  EVENT_ALERT,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
};
