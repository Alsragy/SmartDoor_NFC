'use strict';

/**
 * Konfigurasi Vitest untuk proyek CommonJS.
 *
 * `globals: true` mengekspos API uji (`describe`, `it`, `expect`, dll.) sebagai
 * global sehingga file test tidak perlu meng-`import`/`require('vitest')` —
 * Vitest v5 melarang `require('vitest')` di modul CommonJS. Pendekatan ini
 * menjaga file test tetap gaya CommonJS sambil tetap dapat dijalankan.
 */

const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.{test,spec}.?(c|m)js'],
  },
});
