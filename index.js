// ─────────────────────────────────────────────────────────────────────────────
// OblivionStore API — Cloudflare Worker (D1 + R2)
// Endpoint identik dengan versi Kimi platform agar frontend yang sama bisa
// diarahkan ke worker ini (ubah base URL di src/lib/api.ts).
// ─────────────────────────────────────────────────────────────────────────────

const TTL_MS = () => 15 * 60 * 1000;

// ── Util kripto (Web Crypto) ────────────────────────────────────────────────
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(keyStr, dataStr) {
  const key = await crypto.subtle.importKey("raw", enc.encode(keyStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(dataStr)));
}

async function mintToken(password) {
  const exp = Date.now() + 12 * 3600 * 1000;
  const payload = b64u(enc.encode(String(exp)));
  const sig = await hmac(`oblivion:${password}`, payload);
  return `${payload}.${sig}`;
}

async function verifyToken(token, password) {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = await hmac(`oblivion:${password}`, payload);
  if (sig.length !== expected.length) return false;
  // timing-safe sederhana
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return false;
  return Number(new TextDecoder().decode(unb64u(payload))) > Date.now();
}

// ── Harga efektif ───────────────────────────────────────────────────────────
async function effectivePrice(db, product) {
  const base = product.is_free ? 0 : product.price;
  if (base <= 0) return { base: 0, discountAmount: 0, final: 0, discount: null };
  const ds = await db.prepare("SELECT * FROM discounts WHERE active = 1").all();
  const d = ds.results.find((x) => x.scope === "product" && x.product_id === product.id) || ds.results.find((x) => x.scope === "global") || null;
  if (!d) return { base, discountAmount: 0, final: base, discount: null };
  const amount = d.type === "percent" ? Math.round((base * d.value) / 100) : Math.min(d.value, base);
  return { base, discountAmount: amount, final: Math.max(base - amount, 0), discount: { id: d.id, name: d.name, type: d.type, value: d.value } };
}

// ── Upload/ambil R2 ─────────────────────────────────────────────────────────
async function saveUpload(form, field, prefix, FILES) {
  const f = form.get(field);
  if (f && f.size > 0) {
    const name = `${prefix}/${Date.now()}-${f.name.replace(/[^\w.\-]/g, "_")}`;
    await FILES.put(name, f.stream(), { httpMetadata: { contentType: f.type } });
    return name;
  }
  return null;
}

function cors(c, env) {
  return {
    "Access-Control-Allow-Origin": env.FRONTEND_URL || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Secret",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  };
}

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...extra } });

// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const c = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { headers: c });
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;
    try {
      // ── Publik ──────────────────────────────────────────────────────────
      if (path === "/api/products" && request.method === "GET") {
        const { results } = await db.prepare("SELECT * FROM products ORDER BY id").all();
        const out = await Promise.all(results.map(async (p) => ({ ...p, pricing: await effectivePrice(db, p) })));
        let list = out;
        const cat = url.searchParams.get("category");
        const sub = url.searchParams.get("sub");
        if (cat) list = list.filter((p) => p.category === cat);
        if (sub) list = list.filter((p) => p.sub_category === sub);
        return json({ products: list }, 200, c);
      }
      if (path.startsWith("/api/products/") && request.method === "GET") {
        const id = Number(path.split("/")[3]);
        const p = await db.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
        if (!p) return json({ error: "Produk tidak ditemukan" }, 404, c);
        return json({ product: { ...p, pricing: await effectivePrice(db, p) } }, 200, c);
      }
      if (path === "/api/portfolio" && request.method === "GET") {
        const p = await db.prepare("SELECT * FROM portfolio ORDER BY updated_at DESC LIMIT 1").first();
        return json({ portfolio: p ?? null }, 200, c);
      }
      if (path === "/api/testimonials" && request.method === "GET") {
        const { results } = await db.prepare("SELECT * FROM testimonials ORDER BY id DESC").all();
        return json({ testimonials: results }, 200, c);
      }
      if (path === "/api/checkout" && request.method === "POST") {
        const { productId } = await request.json().catch(() => ({}));
        const p = await db.prepare("SELECT * FROM products WHERE id = ?").bind(Number(productId)).first();
        if (!p) return json({ error: "Produk tidak ditemukan" }, 404, c);
        if (p.is_free || p.price <= 0) return json({ error: "Produk gratis" }, 400, c);
        const pricing = await effectivePrice(db, p);
        const uniqueCode = 101 + Math.floor(Math.random() * 99);
        const finalPrice = pricing.final + uniqueCode;
        const code = crypto.randomUUID().slice(0, 8).toUpperCase();
        const expires = new Date(Date.now() + TTL_MS()).toISOString();
        const r = await db.prepare(
          "INSERT INTO transactions (code, product_id, product_name, base_price, discount_amount, final_price, unique_code, expires_at) VALUES (?,?,?,?,?,?,?,?)"
        ).bind(code, p.id, p.name, pricing.base, pricing.discountAmount, finalPrice, uniqueCode, expires).run();
        const s = await db.prepare("SELECT * FROM settings LIMIT 1").first();
        return json({
          transaction: { id: r.meta.last_row_id, code, productId: p.id, productName: p.name, basePrice: pricing.base, discountAmount: pricing.discountAmount, finalPrice, uniqueCode, status: "pending", expiresAt: expires },
          checkout: { transactionId: r.meta.last_row_id, product: { id: p.id, name: p.name, category: p.category }, basePrice: pricing.base, discountAmount: pricing.discountAmount, uniqueCode, finalPrice, expiresAt: Date.now() + TTL_MS(), qrisKey: p.qris_image_key || s?.qris_image_key || null, paymentMode: s?.payment_mode ?? "personal" },
        }, 200, c);
      }
      if (path.startsWith("/api/transactions/") && path.endsWith("/status") && request.method === "GET") {
        const id = Number(path.split("/")[3]);
        const t = await db.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first();
        if (!t) return json({ error: "Transaksi tidak ditemukan" }, 404, c);
        if (t.status === "pending" && Date.parse(t.expires_at) < Date.now()) {
          await db.prepare("UPDATE transactions SET status = 'expired' WHERE id = ?").bind(id).run();
          return json({ status: "expired" }, 200, c);
        }
        const paid = t.status === "paid" || t.status === "confirmed";
        return json({ status: t.status, downloadToken: paid ? t.download_token : null, downloadUrl: paid && t.download_token ? `/api/download/${t.download_token}` : null }, 200, c);
      }
      if (path === "/api/webhooks/payment" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const s = await db.prepare("SELECT * FROM settings LIMIT 1").first();
        const secret = body.secret || request.headers.get("X-Webhook-Secret") || "";
        if (s?.webhook_secret && secret !== s.webhook_secret) return json({ error: "secret tidak valid" }, 401, c);
        const amount = Number(body.amount ?? body.gross_amount ?? body.nominal);
        if (!Number.isFinite(amount) || amount <= 0) return json({ error: "amount wajib ada" }, 400, c);
        const { results: pending } = await db.prepare("SELECT * FROM transactions WHERE status = 'pending'").all();
        const match = pending.find((t) => t.final_price === amount && Date.parse(t.expires_at) > Date.now());
        if (!match) return json({ matched: false }, 202, c);
        const token = crypto.randomUUID().replace(/-/g, "") + (await hmac("dl", String(match.id))).slice(0, 16);
        await db.prepare("UPDATE transactions SET status = 'paid', paid_at = datetime('now'), download_token = ? WHERE id = ?").bind(token, match.id).run();
        return json({ matched: true, transactionId: match.id }, 200, c);
      }
      if (path.startsWith("/api/download/") && request.method === "GET") {
        const t = await db.prepare("SELECT * FROM transactions WHERE download_token = ?").bind(path.split("/")[3]).first();
        if (!t || !["paid", "confirmed"].includes(t.status)) return json({ error: "Tautan tidak valid" }, 403, c);
        const p = await db.prepare("SELECT * FROM products WHERE id = ?").bind(t.product_id).first();
        const obj = await env.FILES.get(p.file_key);
        if (!obj) return json({ error: "File tidak ditemukan" }, 404, c);
        const ext = p.file_key.split(".").pop() || "bin";
        return new Response(obj.body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${encodeURIComponent(p.name)}.${ext}"` } });
      }
      if (path === "/api/free-download" && request.method === "POST") {
        const { productId } = await request.json().catch(() => ({}));
        const p = await db.prepare("SELECT * FROM products WHERE id = ?").bind(Number(productId)).first();
        if (!p) return json({ error: "Produk tidak ditemukan" }, 404, c);
        if (!p.is_free && p.price > 0) return json({ error: "Produk berbayar" }, 400, c);
        const sig = (await hmac("free", String(p.id))).slice(0, 24);
        return json({ downloadUrl: `/api/download-free/${p.id}.${sig}`, product: { id: p.id, name: p.name } }, 200, c);
      }
      if (path.startsWith("/api/download-free/") && request.method === "GET") {
        const [pid, sig] = path.split("/")[3].split(".");
        const expected = (await hmac("free", pid)).slice(0, 24);
        if (!pid || sig !== expected) return json({ error: "Tautan tidak valid" }, 403, c);
        const p = await db.prepare("SELECT * FROM products WHERE id = ?").bind(Number(pid)).first();
        const obj = p?.file_key ? await env.FILES.get(p.file_key) : null;
        if (!obj) return json({ error: "File tidak ditemukan" }, 404, c);
        const ext = p.file_key.split(".").pop() || "bin";
        return new Response(obj.body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${encodeURIComponent(p.name)}.${ext}"` } });
      }
      if (path === "/api/auth/login" && request.method === "POST") {
        const { password } = await request.json().catch(() => ({}));
        if (password !== env.ADMIN_PASSWORD) return json({ error: "Password salah" }, 401, c);
        return json({ token: await mintToken(env.ADMIN_PASSWORD) }, 200, c);
      }
      // ── Admin (Bearer) ─────────────────────────────────────────────────
      if (path.startsWith("/api/admin/")) {
        const auth = request.headers.get("Authorization") || "";
        if (!(await verifyToken(auth.replace(/^Bearer\s+/i, ""), env.ADMIN_PASSWORD))) return json({ error: "Unauthorized" }, 401, c);
        const sub = path.replace("/api/admin", "");
        const parts = sub.split("/").filter(Boolean);
        const form = ["POST", "PUT"].includes(request.method) && request.headers.get("Content-Type")?.includes("multipart")
          ? await request.formData() : null;

        if (sub === "/products" && request.method === "GET") {
          const { results } = await db.prepare("SELECT * FROM products ORDER BY id").all();
          return json({ products: results }, 200, c);
        }
        if (sub === "/products" && request.method === "POST") {
          const isFree = form.get("isFree") === "true";
          const thumb = await saveUpload(form, "thumbnail", "thumbnails", env.FILES);
          const file = await saveUpload(form, "file", "products", env.FILES);
          const qris = await saveUpload(form, "qrisImage", "qris", env.FILES);
          const r = await db.prepare(
            "INSERT INTO products (name, category, sub_category, description, price, is_free, thumbnail_key, file_key, qris_image_key, featured) VALUES (?,?,?,?,?,?,?,?,?,?)"
          ).bind(form.get("name") || "", form.get("category") === "minecraft" ? "minecraft" : "jasa", ["modpack", "addon"].includes(form.get("subCategory")) ? form.get("subCategory") : "plugin",
            form.get("description") || "", isFree ? 0 : Math.max(0, Number(form.get("price")) || 0), isFree ? 1 : 0, thumb, file, qris,
            form.get("featured") === "true" ? 1 : 0).run();
          return json({ ok: true, id: r.meta.last_row_id }, 200, c);
        }
        if (parts[0] === "products" && parts[1] && request.method === "PUT") {
          const id = Number(parts[1]);
          const ex = await db.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
          if (!ex) return json({ error: "Produk tidak ditemukan" }, 404, c);
          const isFree = form.get("isFree") === "true";
          const thumb = (await saveUpload(form, "thumbnail", "thumbnails", env.FILES)) || ex.thumbnail_key;
          const file = (await saveUpload(form, "file", "products", env.FILES)) || ex.file_key;
          const qris = (await saveUpload(form, "qrisImage", "qris", env.FILES)) || ex.qris_image_key;
          await db.prepare(
            "UPDATE products SET name=?, category=?, sub_category=?, description=?, price=?, is_free=?, thumbnail_key=?, file_key=?, qris_image_key=?, featured=?, updated_at=datetime('now') WHERE id=?"
          ).bind(form.get("name") || ex.name, form.get("category") === "minecraft" ? "minecraft" : "jasa", ["modpack", "addon"].includes(form.get("subCategory")) ? form.get("subCategory") : "plugin",
            form.get("description") ?? (ex.description || ""), isFree ? 0 : Math.max(0, Number(form.get("price") ?? ex.price) || 0), isFree ? 1 : 0, thumb, file, qris,
            form.get("featured") === "true" ? 1 : 0, id).run();
          return json({ ok: true }, 200, c);
        }
        if (parts[0] === "products" && parts[1] && request.method === "DELETE") {
          await db.prepare("DELETE FROM products WHERE id = ?").bind(Number(parts[1])).run();
          return json({ ok: true }, 200, c);
        }
        if (sub === "/discounts" && request.method === "GET") {
          const { results } = await db.prepare("SELECT * FROM discounts ORDER BY id DESC").all();
          return json({ discounts: results }, 200, c);
        }
        if (sub === "/discounts" && request.method === "POST") {
          const b = await request.json();
          const r = await db.prepare("INSERT INTO discounts (name, scope, product_id, type, value) VALUES (?,?,?,?,?)")
            .bind(b.name || "Diskon", b.scope === "product" ? "product" : "global", b.scope === "product" ? Number(b.productId) : null, b.type === "nominal" ? "nominal" : "percent", Math.max(0, Number(b.value) || 0)).run();
          return json({ ok: true, id: r.meta.last_row_id }, 200, c);
        }
        if (parts[0] === "discounts" && parts[1]) {
          const id = Number(parts[1]);
          if (request.method === "PUT") {
            const b = await request.json();
            await db.prepare("UPDATE discounts SET name=?, scope=?, product_id=?, type=?, value=?, active=? WHERE id=?")
              .bind(b.name || "Diskon", b.scope === "product" ? "product" : "global", b.scope === "product" ? Number(b.productId) : null, b.type === "nominal" ? "nominal" : "percent", Math.max(0, Number(b.value) || 0), b.active === false ? 0 : 1, id).run();
            return json({ ok: true }, 200, c);
          }
          if (request.method === "DELETE") {
            await db.prepare("DELETE FROM discounts WHERE id = ?").bind(id).run();
            return json({ ok: true }, 200, c);
          }
        }
        if (sub === "/portfolio" && request.method === "GET") {
          const p = await db.prepare("SELECT * FROM portfolio ORDER BY updated_at DESC LIMIT 1").first();
          return json({ portfolio: p ?? null }, 200, c);
        }
        if (sub === "/portfolio" && request.method === "POST") {
          const n = await db.prepare("SELECT COUNT(*) n FROM portfolio").first();
          if (n.n >= 1) return json({ error: "Portofolio hanya boleh ditambah sekali. Silakan edit data yang ada." }, 409, c);
          const img = await saveUpload(form, "image", "portfolio", env.FILES);
          const r = await db.prepare("INSERT INTO portfolio (title, category, description, image_key) VALUES (?,?,?,?)")
            .bind(form.get("title") || "", form.get("category") || "minecraft", form.get("description") || "", img).run();
          return json({ ok: true, id: r.meta.last_row_id }, 200, c);
        }
        if (parts[0] === "portfolio" && parts[1]) {
          const id = Number(parts[1]);
          if (request.method === "PUT") {
            const ex = await db.prepare("SELECT * FROM portfolio WHERE id = ?").bind(id).first();
            if (!ex) return json({ error: "Tidak ditemukan" }, 404, c);
            const img = (await saveUpload(form, "image", "portfolio", env.FILES)) || ex.image_key;
            await db.prepare("UPDATE portfolio SET title=?, category=?, description=?, image_key=?, updated_at=datetime('now') WHERE id=?")
              .bind(form.get("title") || ex.title, form.get("category") || ex.category, form.get("description") ?? (ex.description || ""), img, id).run();
            return json({ ok: true }, 200, c);
          }
          if (request.method === "DELETE") {
            await db.prepare("DELETE FROM portfolio WHERE id = ?").bind(id).run();
            return json({ ok: true }, 200, c);
          }
        }
        if (sub === "/testimonials" && request.method === "GET") {
          const { results } = await db.prepare("SELECT * FROM testimonials ORDER BY id DESC").all();
          return json({ testimonials: results }, 200, c);
        }
        if (sub === "/testimonials" && request.method === "POST") {
          const photo = await saveUpload(form, "photo", "testimonials", env.FILES);
          const r = await db.prepare("INSERT INTO testimonials (customer_name, review, photo_key, rating) VALUES (?,?,?,?)")
            .bind(form.get("customerName") || "", form.get("review") || "", photo, Math.min(5, Math.max(1, Number(form.get("rating")) || 5))).run();
          return json({ ok: true, id: r.meta.last_row_id }, 200, c);
        }
        if (parts[0] === "testimonials" && parts[1]) {
          const id = Number(parts[1]);
          if (request.method === "PUT") {
            const ex = await db.prepare("SELECT * FROM testimonials WHERE id = ?").bind(id).first();
            if (!ex) return json({ error: "Tidak ditemukan" }, 404, c);
            const photo = (await saveUpload(form, "photo", "testimonials", env.FILES)) || ex.photo_key;
            await db.prepare("UPDATE testimonials SET customer_name=?, review=?, photo_key=?, rating=? WHERE id=?")
              .bind(form.get("customerName") || ex.customer_name, form.get("review") || ex.review, photo, Math.min(5, Math.max(1, Number(form.get("rating") ?? ex.rating) || 5)), id).run();
            return json({ ok: true }, 200, c);
          }
          if (request.method === "DELETE") {
            await db.prepare("DELETE FROM testimonials WHERE id = ?").bind(id).run();
            return json({ ok: true }, 200, c);
          }
        }
        if (sub === "/transactions" && request.method === "GET") {
          const { results } = await db.prepare("SELECT * FROM transactions ORDER BY id").all();
          return json({ transactions: results }, 200, c);
        }
        if (parts[0] === "transactions" && parts[1] && parts[2] === "confirm" && request.method === "POST") {
          const id = Number(parts[1]);
          const token = crypto.randomUUID().replace(/-/g, "") + (await hmac("dl", String(id))).slice(0, 16);
          await db.prepare("UPDATE transactions SET status='confirmed', paid_at=datetime('now'), download_token=? WHERE id=?").bind(token, id).run();
          return json({ ok: true, downloadToken: token }, 200, c);
        }
        if (sub === "/settings" && request.method === "GET") {
          const s = await db.prepare("SELECT * FROM settings LIMIT 1").first();
          return json({ settings: s ?? null }, 200, c);
        }
        if (sub === "/settings" && request.method === "PUT") {
          const ex = await db.prepare("SELECT * FROM settings LIMIT 1").first();
          const qris = (await saveUpload(form, "qrisImage", "qris", env.FILES)) || ex?.qris_image_key || null;
          if (ex) await db.prepare("UPDATE settings SET payment_mode=?, qris_image_key=?, webhook_secret=?, updated_at=datetime('now') WHERE id=?")
            .bind(form.get("paymentMode") === "webhook" ? "webhook" : "personal", qris, form.get("webhookSecret") ?? (ex.webhook_secret || ""), ex.id).run();
          else await db.prepare("INSERT INTO settings (payment_mode, qris_image_key, webhook_secret) VALUES (?,?,?)")
            .bind(form.get("paymentMode") === "webhook" ? "webhook" : "personal", qris, form.get("webhookSecret") || "").run();
          return json({ ok: true }, 200, c);
        }
        return json({ error: "Not Found" }, 404, c);
      }
      return json({ error: "Not Found" }, 404, c);
    } catch (err) {
      return json({ error: "Internal Server Error", detail: String(err) }, 500, c);
    }
  },
};
