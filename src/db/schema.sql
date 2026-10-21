-- =============================================================================
-- Smart Door KOS ESP32 — Skema Basis Data (SQLite / better-sqlite3)
-- =============================================================================
-- Skema ini idempoten (CREATE TABLE IF NOT EXISTS) sehingga aman dijalankan
-- berulang kali sebagai migrasi awal oleh src/db/index.js (task 2.2).
--
-- Entitas (lihat design.md "Data Models"):
--   users        — resident/penghuni (Req 8.1)
--   rooms        — kamar kos, satu kamar dilayani satu device (Req 8.2)
--   devices      — satu baris per ESP32/pintu: telemetri (Req 11) + param pintu (Req 17)
--   cards        — kartu NFC kripto; whitelist/versioning untuk delta sync (Req 4, 8, 9)
--   access_logs  — audit trail dengan idempotency & sync_type (Req 6, 15, 19)
--
-- _Requirements: 19.1, 8.3, 8.4, 5.5, 9.1, 11.3, 15.1, 17.1, 17.2, 19.3_
-- =============================================================================

-- Integritas referensial wajib aktif per-koneksi (SQLite default OFF).
-- src/db/index.js juga mengeksekusi PRAGMA ini, dan diulang di sini agar
-- skema tetap benar bila dimuat mandiri (mis. uji syntax in-memory).
PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- users — Resident (Req 8.1)
--   status ∈ ACTIVE | INACTIVE
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  phone      TEXT,
  status     TEXT    NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- -----------------------------------------------------------------------------
-- devices — satu ESP32/pintu (Req 11 telemetri, Req 17 parameter pintu)
--   device_id (PK) berupa string, mis. 'dev01'
--   last_seen/rssi/fs_free/db_version → kesehatan perangkat (Req 11.3)
--   lock_open_duration_s/door_ajar_timeout_s → konfigurasi pintu (Req 17.1, 17.2)
-- Catatan: FK devices.room_id <-> rooms.id dideklarasikan lewat rooms.device_id.
-- Untuk menghindari siklus FK yang memaksa urutan insert ketat, relasi
-- device↔room ditegakkan pada sisi rooms (lihat tabel rooms).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  device_id            TEXT    PRIMARY KEY,
  room_id              INTEGER,
  last_seen            TEXT,
  rssi                 INTEGER,
  fs_free              INTEGER,
  db_version           INTEGER NOT NULL DEFAULT 0,
  lock_open_duration_s INTEGER NOT NULL DEFAULT 5
                               CHECK (lock_open_duration_s > 0),
  door_ajar_timeout_s  INTEGER NOT NULL DEFAULT 30
                               CHECK (door_ajar_timeout_s > 0),
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- -----------------------------------------------------------------------------
-- rooms — kamar kos (Req 8.2)
--   satu kamar dilayani satu device → UNIQUE(device_id) menegakkan 1:1 room↔device
--   room_no unik agar tidak ada duplikasi nomor kamar
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_no    TEXT    NOT NULL UNIQUE,
  device_id  TEXT    UNIQUE
                     REFERENCES devices (device_id)
                       ON UPDATE CASCADE
                       ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- -----------------------------------------------------------------------------
-- cards — kartu NFC kripto / entri whitelist (Req 4, 8, 9)
--   uid (PK)           — identitas kartu; UNIQUE ditegakkan oleh PRIMARY KEY,
--                        ditambah UNIQUE(uid) eksplisit sesuai tasks.
--   user_id/room_id    — binding ketat satu-ke-satu (Req 8.3, 8.4):
--                        UNIQUE(user_id) & UNIQUE(room_id) mencegah rebinding.
--   key_version        — mendukung rotasi kunci & delta sync.
--   status             — ACTIVE | SUSPENDED | REVOKED | UNPROVISIONED.
--   expired_at         — billing-lock (Req 9.1).
--   db_version         — versi perubahan untuk delta sync (Req 4.3).
--   card_hash          — SHA-256 isi relevan kartu untuk db_hash.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cards (
  uid         TEXT    PRIMARY KEY,
  user_id     INTEGER UNIQUE
                      REFERENCES users (id)
                        ON UPDATE CASCADE
                        ON DELETE SET NULL,
  room_id     INTEGER UNIQUE
                      REFERENCES rooms (id)
                        ON UPDATE CASCADE
                        ON DELETE SET NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  status      TEXT    NOT NULL DEFAULT 'UNPROVISIONED'
                      CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED', 'UNPROVISIONED')),
  expired_at  TEXT,
  db_version  INTEGER NOT NULL DEFAULT 0,
  card_hash   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (uid)
);

-- -----------------------------------------------------------------------------
-- access_logs — audit trail (Req 6, 15, 19)
--   idempotency_key — UNIQUE (Req 19.3): INSERT ... ON CONFLICT DO NOTHING
--                     membuat ingest offline-log idempoten (Req 6.4).
--   device_id/uid   — FK ke sumber log (dibiarkan nullable + ON DELETE SET NULL
--                     agar histori audit tidak hilang bila device/kartu dihapus).
--   result          — GRANT | DENY.
--   ts              — timestamp ISO-8601 UTC dari RTC/firmware.
--   ts_unverified   — penanda timestamp tidak terverifikasi (Req 5.5): 1 bila
--                     RTC DS3231 kehilangan daya baterai/ter-reset, selain itu 0.
--   sync_type       — REALTIME | CACHED_OFFLINE (Req 15).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT    NOT NULL UNIQUE,
  device_id       TEXT    REFERENCES devices (device_id)
                            ON UPDATE CASCADE
                            ON DELETE SET NULL,
  uid             TEXT    REFERENCES cards (uid)
                            ON UPDATE CASCADE
                            ON DELETE SET NULL,
  result          TEXT    NOT NULL
                          CHECK (result IN ('GRANT', 'DENY')),
  ts              TEXT    NOT NULL,
  ts_unverified   INTEGER NOT NULL DEFAULT 0
                          CHECK (ts_unverified IN (0, 1)),
  sync_type       TEXT    NOT NULL
                          CHECK (sync_type IN ('REALTIME', 'CACHED_OFFLINE')),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- -----------------------------------------------------------------------------
-- Indeks pendukung query umum dashboard & delta sync.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cards_status      ON cards (status);
CREATE INDEX IF NOT EXISTS idx_cards_db_version  ON cards (db_version);
CREATE INDEX IF NOT EXISTS idx_cards_expired_at  ON cards (expired_at);
CREATE INDEX IF NOT EXISTS idx_logs_device_ts    ON access_logs (device_id, ts);
CREATE INDEX IF NOT EXISTS idx_logs_uid          ON access_logs (uid);
CREATE INDEX IF NOT EXISTS idx_logs_sync_type    ON access_logs (sync_type);
