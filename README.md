# OblivionStore — Deploy Gratis ke Cloudflare (Pages + Workers + D1 + R2)

Paket ini adalah implementasi backend **Cloudflare Worker** yang setara dengan versi Kimi
platform yang sudah jalan, sehingga frontend yang sama bisa di-deploy ke Cloudflare Pages
100% gratis (tanpa VPS, tanpa Midtrans/Xendit, tanpa KTP).

## Arsitektur

| Komponen | Layanan Cloudflare | Fungsi |
|---|---|---|
| Frontend | Cloudflare Pages | React/Vite build (`dist/`) |
| Backend API | Cloudflare Workers | Auth admin, CRUD, checkout, webhook, proteksi unduhan |
| Database | Cloudflare D1 (SQLite) | `products`, `discounts`, `portfolio`, `testimonials`, `transactions`, `settings` |
| File storage | Cloudflare R2 | File produk, thumbnail, gambar QRIS, foto testimoni/portofolio |

## Langkah Setup

### 1. Backend (Worker + D1 + R2)

```bash
cd cloudflare-oblivionstore

# Buat database D1
npx wrangler d1 create oblivionstore-db
# Salin database_id ke wrangler.toml

# Jalankan skema
npx wrangler d1 execute oblivionstore-db --file=schema.sql

# Buat bucket R2
npx wrangler r2 bucket create oblivionstore-files

# Set password admin (SECRET — jangan di-hardcode)
npx wrangler secret put ADMIN_PASSWORD

# Deploy worker
npx wrangler deploy
```

### 2. Frontend (Cloudflare Pages)

```bash
cd ../app          # proyek React/Vite
# Di src/lib/api.ts, ganti base URL fetch ("/api/...") menjadi worker URL Anda,
# mis. "https://oblivionstore-api.<subdomain>.workers.dev/api/..."
npm run build
npx wrangler pages deploy dist --project-name=oblivionstore
```

### 3. QRIS & Pembayaran (tanpa merchant resmi)

Upload gambar **QRIS personal** (GoPay/OVO/DANA/QRIS gabungan) lewat
**Panel Admin → Pengaturan**. Sistem otomatis menambahkan **kode unik 3 digit**
(101–199) ke nominal setiap transaksi — itulah kunci verifikasinya.

**Verifikasi otomatis (pilih salah satu):**

1. **Webhook platform kreator** — SociaBuzz / Saweria / Trakteer punya fitur
   notifikasi webhook. Arahkan ke:
   `POST https://oblivionstore-api.<sub>.workers.dev/api/webhooks/payment`
   dengan payload `{ "amount": <nominal masuk> }` dan secret yang sama dengan
   `webhook_secret` di Pengaturan (dikirim via header `X-Webhook-Secret`).
   Worker mencocokkan nominal dengan transaksi `pending` yang masih berlaku.
2. **Notifikasi HP (MacroDroid/Tasker)** — buat trigger "SMS/notifikasi mutasi
   e-wallet masuk", lalu HTTP POST ke endpoint webhook di atas.
3. **Konfirmasi manual** — di **Panel Admin → Transaksi**, tekan
   *Konfirmasi Bayar* setelah mengecek kode unik di mutasi rekening.

### 4. Admin

- Buka situs → klik ikon **gear (⚙️)** kanan bawah → login.
- Password default untuk development: `oblivionstore123`.
  **Wajib ganti** via `npx wrangler secret put ADMIN_PASSWORD`.

## Endpoint Utama

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/products?category=&sub=` | Katalog + harga efektif (diskon) |
| POST | `/api/checkout` | Buat sesi pembayaran (nominal unik) |
| GET | `/api/transactions/:id/status` | Polling status |
| POST | `/api/webhooks/payment` | Webhook SociaBuzz/Saweria/Trakteer/MacroDroid |
| GET | `/api/download/:token` | Unduh file berbayar (token sementara) |
| POST | `/api/free-download` | Tautan unduh produk gratis |
| POST | `/api/auth/login` | Login admin (password dari secret) |
| * | `/api/admin/*` | CRUD produk, diskon, portofolio, testimoni, transaksi, pengaturan |

Aturan portofolio: tambah hanya sekali (HTTP 409 bila sudah ada), edit tetap bebas.
