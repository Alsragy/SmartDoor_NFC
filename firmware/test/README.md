# firmware/test — Test host untuk logika portabel

Test di sini berjalan di **host** (bukan perangkat) melalui environment
`[env:native]` menggunakan framework Unity bawaan PlatformIO:

```bash
pio test -e native
```

## Konvensi PlatformIO

- Setiap suite berada di subfolder `test_<nama>/` dengan satu file sumber
  berisi `setup()`/`loop()` Unity (atau `main()` untuk native) yang memanggil
  `RUN_TEST(...)`.
- Test hanya memakai modul portabel dari `firmware/lib/` (tanpa Arduino/HW).

## Rencana suite (Task 22.4)

Verifikasi paritas logika firmware dengan Correctness Properties:

- Property 4  — keputusan akses dari whitelist lokal (`decision/`)
- Property 6  — pencabutan menghapus akses tepat sasaran (`whitelist/`)
- Property 7  — delta sync merekonstruksi state server (`whitelist/`)
- Property 8  — round-trip serialisasi log offline (`whitelist/`)
- Property 9  — pengosongan antrean hanya untuk entri ber-ACK (`whitelist/`)
- Property 13 — pemicu deteksi brute-force (`security/`)
- Property 14 — pemicu deteksi tamper (`security/`)
- Property 17 — alarm door-ajar sesuai timeout (`security/`)

Setiap test menandai: **Feature: smart-door-kos-esp32, Property {n}: {teks}**.
