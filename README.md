# OblivionStore — Full-Stack Webstore (Cloudflare Workers + D1 + R2 + Pages)

**Tagline:** Toko pilihan untuk kebutuhan game

## Struktur Paket File
- `backend/schema.sql` — Skema database Cloudflare D1 (`products`, `discounts`, `portfolio`, `testimonials`, `transactions`) + data contoh awal.
- `backend/wrangler.toml` — Konfigurasi Worker, D1 Database, dan R2 Storage.
- `backend/src/index.js` — Kode lengkap REST API Backend, Checkout QRIS, Webhook Pembayaran Otomatis, dan Admin API.
- `frontend/index.html` — Tampilan penuh *dark-mode obsidian* siap deploy ke Cloudflare Pages.

## Cara Deploy (100% Lewat Browser / GitHub)

### 1. Setup Database D1
1. Buka **Cloudflare Dashboard** > **Storage & Databases** > **D1 SQL Database**.
2. Pilih database `oblivionstore-db` Anda > buka tab **Console**.
3. Salin seluruh isi `backend/schema.sql`, tempel ke Console, lalu klik **Execute**.

### 2. Update Backend Worker
1. Buka `backend/wrangler.toml`, ganti `GANTI_DENGAN_DATABASE_ID_D1_ANDA` dengan Database ID D1 Anda (misal: `f60596c9-793b-4b0d-9e0e-f9be557c4453`).
2. Unggah isi folder `backend/` (`src/index.js`, `wrangler.toml`, `schema.sql`) ke repository GitHub Worker Anda agar otomatis ter-deploy.
3. Di menu **Workers & Pages** > `oblivionstore` > **Settings** > **Variables and Secrets**, tambahkan:
   - `ADMIN_PASSWORD` = `oblivionstore123` (atau ganti dengan password pilihan Anda).
   - `DEFAULT_QRIS_IMAGE` = URL gambar QRIS Anda (dari Saweria / SociaBuzz / QRIS Personal).

### 3. Deploy Frontend ke Cloudflare Pages
1. Buka `frontend/index.html`, pastikan baris `const API_BASE_URL = "https://oblivionstore.oblivionstore.workers.dev";` sudah sesuai dengan URL Worker Anda.
2. Upload folder `frontend/` (berisi `index.html`) ke repository GitHub baru (misal `oblivionstore-web`), atau upload langsung via **Workers & Pages** > **Create** > **Pages** > **Upload assets**.

### 4. Menghubungkan Pembayaran QRIS Otomatis (Non-KTP)
- **Via Saweria / SociaBuzz / Trakteer:**
  1. Pasang gambar QRIS halaman dukungan Anda sebagai `DEFAULT_QRIS_IMAGE` (atau pada tiap produk di Admin Panel).
  2. Masuk ke pengaturan **Webhook / Integration** di dashboard Saweria/SociaBuzz Anda, lalu masukkan URL Webhook Worker:
     `https://oblivionstore.oblivionstore.workers.dev/api/webhook/payment`
  3. Setiap kali pembeli melakukan scan QRIS dan transfer sesuai nominal unik, webhook otomatis menandai transaksi `PAID` dan memunculkan tombol download di layar pembeli.
- **Via QRIS Personal + MacroDroid (HP Android):**
  Atur MacroDroid di HP untuk meneruskan notifikasi masuk dari aplikasi DANA/GoPay/M-Banking melalui HTTP POST JSON `{"text": "{notifikasi}"}` ke URL webhook di atas.
