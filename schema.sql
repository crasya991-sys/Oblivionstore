-- OblivionStore — Skema Cloudflare D1 (SQLite)
-- Jalankan: npx wrangler d1 execute oblivionstore-db --file=schema.sql

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('jasa','minecraft')),
  sub_category TEXT NOT NULL DEFAULT 'plugin' CHECK (sub_category IN ('plugin','modpack','addon')),
  description TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  is_free INTEGER NOT NULL DEFAULT 0,
  thumbnail_key TEXT,
  file_key TEXT,
  qris_image_key TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','product')),
  product_id INTEGER,
  type TEXT NOT NULL DEFAULT 'percent' CHECK (type IN ('percent','nominal')),
  value INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'minecraft',
  description TEXT,
  image_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS testimonials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  review TEXT NOT NULL,
  photo_key TEXT,
  rating INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  base_price INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  final_price INTEGER NOT NULL,
  unique_code INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','confirmed')),
  download_token TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_mode TEXT NOT NULL DEFAULT 'personal' CHECK (payment_mode IN ('personal','webhook')),
  qris_image_key TEXT,
  webhook_secret TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
