-- OblivionStore Database Schema (Cloudflare D1)
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS discounts;
DROP TABLE IF EXISTS testimonials;
DROP TABLE IF EXISTS portfolio;
DROP TABLE IF EXISTS products;

CREATE TABLE products (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('Jasa', 'Minecraft')),
    subcategory TEXT CHECK (subcategory IN ('Plugin', 'Modpack', 'Add-on', NULL)),
    is_free INTEGER NOT NULL DEFAULT 0,
    price INTEGER NOT NULL DEFAULT 0,
    thumbnail_url TEXT,
    file_key TEXT,
    file_name TEXT,
    file_url_fallback TEXT,
    qris_image_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE discounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
    discount_value INTEGER NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'product')),
    product_id TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE portfolio (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    image_url TEXT,
    project_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE testimonials (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    customer_role TEXT,
    rating INTEGER NOT NULL DEFAULT 5,
    description TEXT NOT NULL,
    photo_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    order_code TEXT UNIQUE NOT NULL,
    product_id TEXT NOT NULL,
    buyer_name TEXT,
    buyer_contact TEXT,
    base_price INTEGER NOT NULL,
    discount_amount INTEGER NOT NULL DEFAULT 0,
    unique_code INTEGER NOT NULL,
    final_amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'EXPIRED')),
    download_token TEXT,
    expires_at INTEGER NOT NULL,
    paid_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX idx_transactions_order_code ON transactions(order_code);
CREATE INDEX idx_transactions_final_amount ON transactions(final_amount, status);
CREATE INDEX idx_transactions_token ON transactions(download_token);

-- Seed Data Awal (Opsional agar etalase langsung hidup)
INSERT INTO products (id, title, description, category, subcategory, is_free, price, thumbnail_url, file_url_fallback) VALUES
('prod-01', 'Setup Server Survival RPG Full Custom', 'Jasa konfigurasi server Minecraft Paper/Purpur lengkap dengan Custom Items, Quests, Economy, Rank Permissions, dan Anti-Cheat.', 'Jasa', NULL, 0, 150000, 'https://images.unsplash.com/photo-1614680376593-902f74cf0d41?auto=format&fit=crop&w=800&q=80', ''),
('prod-02', 'OblivionCore Essentials Plugin (1.20 - 1.21)', 'Plugin inti ringan dengan sistem /home, /warp, /tpa, economy vault, dan scoreboard dinamis tanpa lag (0.01ms tick).', 'Minecraft', 'Plugin', 0, 45000, 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?auto=format&fit=crop&w=800&q=80', ''),
('prod-03', 'Obsidian Dark UI Resource & Add-on Pack', 'Add-on Bedrock & MCPE mengubah seluruh tampilan inventory, HUD, dan tombol menjadi tema obsidian gelap transparan.', 'Minecraft', 'Add-on', 1, 0, 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=800&q=80', 'https://example.com/obsidian-ui.mcaddon'),
('prod-04', 'Aetheris Fantasy Adventure Modpack', 'Modpack 140+ mod bertema dungeon, boss fight, magic, dan optimasi FPS tinggi untuk PC spesifikasi menengah.', 'Minecraft', 'Modpack', 0, 65000, 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=800&q=80', '');

INSERT INTO testimonials (id, customer_name, customer_role, rating, description, photo_url) VALUES
('testi-01', 'Raka Pratama', 'Owner NusantaraMC', 5, 'Pengerjaan setup server cepat banget, TPS stabil di 20.0 meski pemain tembus 80 online bersamaan. Sangat direkomendasikan!', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'),
('testi-02', 'Dimas Aditya', 'Server Admin', 5, 'Plugin OblivionCore ringan dan konfigurasinya gampang dipahami. Checkout QRIS otomatis langsung dapat link download dalam hitungan detik.', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=200&q=80');
