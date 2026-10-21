'use strict';

/**
 * Lapisan koneksi basis data — Smart Door KOS ESP32 (Web Server Node.js).
 *
 * Tanggung jawab (task 2.2):
 *   - Membuka/membuat file SQLite via better-sqlite3 (path dari env, default
 *     ke data/, mendukung ':memory:' untuk pengujian).
 *   - Mengaktifkan PRAGMA foreign_keys = ON dan journal mode WAL yang masuk akal.
 *   - Menjalankan migrasi awal dengan mengeksekusi src/db/schema.sql secara
 *     idempoten pada saat startup.
 *   - Mengekspos instance DB tunggal bersama dan helper transaksi `tx(fn)`.
 *   - Menyediakan factory `createDatabase()` untuk instance in-memory terisolasi
 *     agar dapat dipakai task uji berikutnya.
 *
 * _Requirements: 19.1_
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/** Lokasi file skema DDL idempoten (task 2.1). */
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/** Default path file DB bila env tidak disetel: <workspace>/data/smartdoor.db */
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'smartdoor.db');

/**
 * Tentukan path DB efektif.
 * Prioritas: argumen eksplisit > env SMARTDOOR_DB_PATH > default data/smartdoor.db.
 * @param {string} [explicitPath] path eksplisit opsional.
 * @returns {string} path file DB atau ':memory:'.
 */
function resolveDbPath(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.SMARTDOOR_DB_PATH) return process.env.SMARTDOOR_DB_PATH;
  return DEFAULT_DB_PATH;
}

/**
 * Baca isi skema DDL dari schema.sql.
 * @returns {string} seluruh pernyataan DDL.
 */
function readSchemaSql() {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

/**
 * Jalankan migrasi awal (idempoten) pada koneksi yang diberikan.
 * schema.sql menggunakan CREATE TABLE/INDEX IF NOT EXISTS sehingga aman
 * dijalankan berulang kali.
 * @param {import('better-sqlite3').Database} db
 */
function runMigrations(db) {
  db.exec(readSchemaSql());
}

/**
 * Terapkan PRAGMA koneksi: integritas referensial & journal mode.
 * WAL tidak didukung untuk DB in-memory, sehingga dilewati bila ':memory:'.
 * @param {import('better-sqlite3').Database} db
 * @param {boolean} isMemory apakah DB berada di memori.
 */
function applyPragmas(db, isMemory) {
  // FK wajib aktif per-koneksi (SQLite default OFF).
  db.pragma('foreign_keys = ON');
  if (!isMemory) {
    // WAL meningkatkan konkurensi baca/tulis untuk DB berbasis file.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
}

/**
 * Pasang helper transaksi `tx(fn)` pada instance DB.
 * Membungkus better-sqlite3 `db.transaction` sehingga seluruh operasi di dalam
 * `fn` berjalan atomik (commit bila sukses, rollback bila melempar error).
 * @param {import('better-sqlite3').Database} db
 * @returns {<T>(fn: (db: import('better-sqlite3').Database) => T) => T}
 */
function makeTx(db) {
  /**
   * Jalankan `fn` di dalam transaksi atomik.
   * @template T
   * @param {(db: import('better-sqlite3').Database) => T} fn
   * @returns {T} nilai kembalian dari `fn`.
   */
  return function tx(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('tx(fn): fn harus berupa function');
    }
    const wrapped = db.transaction(() => fn(db));
    return wrapped();
  };
}

/**
 * Buat instance basis data baru yang telah dikonfigurasi & bermigrasi.
 *
 * Berguna untuk pengujian terisolasi (mis. `createDatabase(':memory:')`)
 * tanpa menyentuh instance bersama.
 *
 * @param {string} [dbPath] path file DB atau ':memory:'. Default mengikuti
 *   env SMARTDOOR_DB_PATH atau data/smartdoor.db.
 * @param {object} [options] opsi tambahan better-sqlite3.
 * @returns {import('better-sqlite3').Database & { tx: Function }} instance DB
 *   dengan method `tx` terpasang.
 */
function createDatabase(dbPath, options = {}) {
  const resolved = resolveDbPath(dbPath);
  const isMemory = resolved === ':memory:';

  // Pastikan direktori induk ada untuk DB berbasis file.
  if (!isMemory) {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolved, options);
  applyPragmas(db, isMemory);
  runMigrations(db);

  // Pasang helper transaksi pada instance agar ergonomis: db.tx(fn).
  db.tx = makeTx(db);

  return db;
}

/**
 * Instance DB tunggal bersama untuk aplikasi (lazy singleton).
 * Mengembalikan instance yang sama pada panggilan berikutnya.
 * @type {(import('better-sqlite3').Database & { tx: Function }) | null}
 */
let sharedDb = null;

/**
 * Dapatkan instance DB bersama (membuatnya pada panggilan pertama).
 * @returns {import('better-sqlite3').Database & { tx: Function }}
 */
function getDb() {
  if (!sharedDb) {
    sharedDb = createDatabase();
  }
  return sharedDb;
}

/**
 * Jalankan `fn` di dalam transaksi pada instance DB bersama.
 * @template T
 * @param {(db: import('better-sqlite3').Database) => T} fn
 * @returns {T}
 */
function tx(fn) {
  return getDb().tx(fn);
}

/**
 * Tutup instance DB bersama (mis. saat shutdown/teardown uji).
 */
function closeDb() {
  if (sharedDb) {
    sharedDb.close();
    sharedDb = null;
  }
}

module.exports = {
  // Instance bersama & helper utama.
  getDb,
  tx,
  closeDb,
  // Factory untuk instance terisolasi (dipakai pengujian).
  createDatabase,
  // Util & konstanta yang diekspos untuk keperluan uji/lanjutan.
  resolveDbPath,
  runMigrations,
  SCHEMA_PATH,
  DEFAULT_DB_PATH,
};

/**
 * Akses properti `db` sebagai instance bersama secara lazy.
 * Memungkinkan pola `const { db } = require('./db')` di modul lain.
 */
Object.defineProperty(module.exports, 'db', {
  enumerable: true,
  get() {
    return getDb();
  },
});
