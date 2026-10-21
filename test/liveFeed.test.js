'use strict';

/**
 * Unit test — Smart Door KOS ESP32.
 *
 * Menguji `liveFeed` SSE hub (Req 14.1 live feed, Req 13.3 alert, Req 14.2
 * tanpa replay untuk klien terputus). Memakai objek response/req PALSU yang
 * hanya menyediakan `write`/`end`/`on` agar hub dapat diuji tanpa server HTTP.
 *
 * `describe`/`it`/`expect` tersedia sebagai global (vitest.config.js:
 * `globals: true`).
 */

const {
  LiveFeedHub,
  formatSseFrame,
  EVENT_ACCESS,
  EVENT_ALERT,
} = require('../src/services/liveFeed');

/**
 * Buat pasangan req/res palsu yang merekam apa yang ditulis dan menyimpan
 * handler 'close' agar uji dapat mensimulasikan diskoneksi.
 */
function makeFakeClient() {
  const writes = [];
  let closeHandler = null;
  const res = {
    headers: null,
    ended: false,
    write(chunk) {
      writes.push(chunk);
      return true;
    },
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end() {
      res.ended = true;
    },
    on() {
      // res tidak dipakai untuk close pada uji ini (req yang menyediakannya).
    },
  };
  const req = {
    on(event, handler) {
      if (event === 'close') {
        closeHandler = handler;
      }
    },
  };
  return {
    req,
    res,
    writes,
    triggerClose: () => closeHandler && closeHandler(),
  };
}

describe('liveFeed SSE hub', () => {
  it('formatSseFrame menghasilkan frame SSE yang benar', () => {
    const frame = formatSseFrame('access', { result: 'GRANT' });
    expect(frame).toBe('event: access\ndata: {"result":"GRANT"}\n\n');
  });

  it('addClient menyetel header text/event-stream dan mengalirkan koneksi', () => {
    const hub = new LiveFeedHub({ heartbeatIntervalMs: 0 });
    const client = makeFakeClient();

    hub.addClient(client.req, client.res);

    expect(client.res.status).toBe(200);
    expect(client.res.headers['Content-Type']).toBe('text/event-stream');
    expect(client.res.headers['Cache-Control']).toContain('no-cache');
    expect(client.writes[0]).toBe(': connected\n\n');
    expect(hub.clientCount).toBe(1);

    hub.close();
  });

  it('broadcast menulis frame access/alert ke klien terhubung', () => {
    const hub = new LiveFeedHub({ heartbeatIntervalMs: 0 });
    const client = makeFakeClient();
    hub.addClient(client.req, client.res);

    const accessLog = { device_id: 'dev01', uid: 'ABCD', result: 'GRANT', ts: '2024-01-01T00:00:00Z' };
    const delivered = hub.publishAccessLog(accessLog);
    expect(delivered).toBe(1);

    const alert = { device_id: 'dev01', type: 'tamper', ts: '2024-01-01T00:01:00Z' };
    hub.publishAlert(alert);

    // writes[0] adalah komentar ': connected', lalu frame access, lalu alert.
    expect(client.writes[1]).toBe(
      `event: ${EVENT_ACCESS}\ndata: ${JSON.stringify(accessLog)}\n\n`
    );
    expect(client.writes[2]).toBe(
      `event: ${EVENT_ALERT}\ndata: ${JSON.stringify(alert)}\n\n`
    );

    hub.close();
  });

  it('broadcast menjangkau beberapa klien sekaligus', () => {
    const hub = new LiveFeedHub({ heartbeatIntervalMs: 0 });
    const a = makeFakeClient();
    const b = makeFakeClient();
    hub.addClient(a.req, a.res);
    hub.addClient(b.req, b.res);

    const delivered = hub.publishAccessLog({ result: 'DENY' });
    expect(delivered).toBe(2);
    expect(a.writes).toHaveLength(2);
    expect(b.writes).toHaveLength(2);

    hub.close();
  });

  it('klien yang terputus TIDAK menerima event berikutnya (Req 14.2: tanpa replay)', () => {
    const hub = new LiveFeedHub({ heartbeatIntervalMs: 0 });
    const client = makeFakeClient();
    hub.addClient(client.req, client.res);

    // Event pertama diterima selagi terhubung.
    hub.publishAccessLog({ seq: 1 });
    const writesAfterFirst = client.writes.length;

    // Simulasikan koneksi putus.
    client.triggerClose();
    expect(hub.clientCount).toBe(0);
    expect(client.res.ended).toBe(true);

    // Event yang terjadi selagi terputus harus HILANG (tidak ditulis & tidak
    // di-replay). broadcast mengembalikan 0 penerima.
    const delivered = hub.publishAccessLog({ seq: 2 });
    expect(delivered).toBe(0);
    expect(client.writes.length).toBe(writesAfterFirst);

    hub.close();
  });

  it('removeClient idempoten dan menutup koneksi', () => {
    const hub = new LiveFeedHub({ heartbeatIntervalMs: 0 });
    const client = makeFakeClient();
    hub.addClient(client.req, client.res);

    expect(hub.removeClient(client.res)).toBe(true);
    expect(client.res.ended).toBe(true);
    // Pemanggilan ulang tidak error dan mengembalikan false (sudah tidak ada).
    expect(hub.removeClient(client.res)).toBe(false);
    expect(hub.clientCount).toBe(0);

    hub.close();
  });

  it('klien yang gagal ditulisi dilepas otomatis saat broadcast', () => {
    const hub = new LiveFeedHub({ heartbeatIntervalMs: 0 });
    const client = makeFakeClient();
    hub.addClient(client.req, client.res);

    // Buat write() melempar untuk mensimulasikan koneksi mati.
    client.res.write = () => {
      throw new Error('socket closed');
    };

    const delivered = hub.broadcast('access', { x: 1 });
    expect(delivered).toBe(0);
    expect(hub.clientCount).toBe(0);

    hub.close();
  });

  it('jalur WebSocket opsional menerima JSON { event, data }', () => {
    const hub = new LiveFeedHub({ heartbeatIntervalMs: 0 });
    const sent = [];
    const ws = { send: (msg) => sent.push(msg), on: () => {} };
    hub.addWebSocket(ws);

    hub.publishAlert({ type: 'bruteforce', count: 4 });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({
      event: EVENT_ALERT,
      data: { type: 'bruteforce', count: 4 },
    });

    hub.close();
  });

  it('handler() mengembalikan fungsi Express yang mendaftarkan klien', () => {
    const hub = new LiveFeedHub({ heartbeatIntervalMs: 0 });
    const client = makeFakeClient();
    const handler = hub.handler();
    expect(typeof handler).toBe('function');

    handler(client.req, client.res);
    expect(hub.clientCount).toBe(1);

    hub.close();
  });
});
