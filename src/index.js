/**
 * OblivionStore Full-Stack Backend API (Cloudflare Workers + D1 + Optional R2)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Token",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function generateId(prefix = "id") {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function verifyAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = env.ADMIN_PASSWORD || "oblivionstore123";
  return token.length > 0 && token === expected;
}

// Hitung harga setelah diskon aktif (Global atau Spesifik Produk)
function applyBestDiscount(product, discounts) {
  if (product.is_free === 1 || product.price <= 0) {
    return {
      original_price: 0,
      final_price: 0,
      discount_amount: 0,
      discount_badge: null,
    };
  }

  let bestFinal = product.price;
  let bestBadge = null;

  for (const d of discounts) {
    if (!d.active) continue;
    const isApplicable =
      d.scope === "global" || (d.scope === "product" && d.product_id === product.id);
    if (!isApplicable) continue;

    let candidatePrice = product.price;
    let badgeText = "";

    if (d.discount_type === "percentage") {
      const cut = Math.floor((product.price * d.discount_value) / 100);
      candidatePrice = Math.max(0, product.price - cut);
      badgeText = `-${d.discount_value}%`;
    } else {
      candidatePrice = Math.max(0, product.price - d.discount_value);
      badgeText = `-Rp${Number(d.discount_value).toLocaleString("id-ID")}`;
    }

    if (candidatePrice < bestFinal) {
      bestFinal = candidatePrice;
      bestBadge = badgeText;
    }
  }

  return {
    original_price: product.price,
    final_price: bestFinal,
    discount_amount: product.price - bestFinal,
    discount_badge: bestBadge,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ==========================================
      // 1. HEALTH CHECK & ROOT
      // ==========================================
      if (path === "/" || path === "/api/health") {
        return jsonResponse({
          service: "OblivionStore API",
          status: "online",
          r2_enabled: Boolean(env.BUCKET),
        });
      }

      // ==========================================
      // 2. ADMIN LOGIN
      // ==========================================
      if (path === "/api/admin/login" && request.method === "POST") {
        const body = await request.json();
        const expected = env.ADMIN_PASSWORD || "oblivionstore123";
        if (body.password === expected) {
          return jsonResponse({ success: true, token: expected });
        }
        return jsonResponse({ success: false, error: "Password admin salah." }, 401);
      }

      // ==========================================
      // 3. PUBLIC CATALOG (PRODUCTS + DISCOUNTS)
      // ==========================================
      if (path === "/api/products" && request.method === "GET") {
        const { results: products } = await env.DB.prepare(
          "SELECT * FROM products ORDER BY created_at DESC"
        ).all();
        const { results: discounts } = await env.DB.prepare(
          "SELECT * FROM discounts WHERE active = 1"
        ).all();

        const enriched = products.map((p) => {
          const pricing = applyBestDiscount(p, discounts);
          return {
            id: p.id,
            title: p.title,
            description: p.description,
            category: p.category,
            subcategory: p.subcategory,
            is_free: p.is_free === 1,
            thumbnail_url: p.thumbnail_url,
            file_name: p.file_name,
            has_file: Boolean(p.file_key || p.file_url_fallback),
            ...pricing,
            created_at: p.created_at,
          };
        });

        return jsonResponse({ products: enriched });
      }

      // ==========================================
      // 4. PUBLIC PORTFOLIO & TESTIMONIALS
      // ==========================================
      if (path === "/api/portfolio" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM portfolio ORDER BY created_at DESC"
        ).all();
        return jsonResponse({
          portfolio: results,
          can_create: results.length === 0, // Aturan khusus: hanya bisa tambah 1x
        });
      }

      if (path === "/api/testimonials" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM testimonials ORDER BY created_at DESC"
        ).all();
        return jsonResponse({ testimonials: results });
      }

      // ==========================================
      // 5. FREE PRODUCT DIRECT DOWNLOAD
      // ==========================================
      if (path.startsWith("/api/free-download/") && request.method === "GET") {
        const productId = path.split("/").pop();
        const product = await env.DB.prepare("SELECT * FROM products WHERE id = ?")
          .bind(productId)
          .first();

        if (!product) return jsonResponse({ error: "Produk tidak ditemukan." }, 404);
        if (product.is_free !== 1) {
          return jsonResponse({ error: "Produk ini berbayar, silakan checkout." }, 403);
        }

        if (product.file_key && env.BUCKET) {
          const obj = await env.BUCKET.get(product.file_key);
          if (obj) {
            const headers = new Headers(CORS_HEADERS);
            headers.set(
              "Content-Disposition",
              `attachment; filename="${product.file_name || "oblivionstore-file.zip"}"`
            );
            headers.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
            return new Response(obj.body, { headers });
          }
        }

        if (product.file_url_fallback) {
          return Response.redirect(product.file_url_fallback, 302);
        }

        return jsonResponse({ error: "File belum diunggah oleh admin." }, 404);
      }

      // ==========================================
      // 6. CHECKOUT SESSION (QRIS + KODE UNIK 3 DIGIT)
      // ==========================================
      if (path === "/api/checkout" && request.method === "POST") {
        const body = await request.json();
        const product = await env.DB.prepare("SELECT * FROM products WHERE id = ?")
          .bind(body.product_id)
          .first();

        if (!product) return jsonResponse({ error: "Produk tidak ditemukan." }, 404);
        if (product.is_free === 1) {
          return jsonResponse({ is_free: true, product_id: product.id });
        }

        const { results: discounts } = await env.DB.prepare(
          "SELECT * FROM discounts WHERE active = 1"
        ).all();
        const pricing = applyBestDiscount(product, discounts);

        // Buat kode unik 3 digit (101 - 999) yang belum dipakai transaksi PENDING lain
        let uniqueCode = Math.floor(101 + Math.random() * 898);
        let finalAmount = pricing.final_price + uniqueCode;

        const existing = await env.DB.prepare(
          "SELECT id FROM transactions WHERE final_amount = ? AND status = 'PENDING'"
        )
          .bind(finalAmount)
          .first();

        if (existing) {
          uniqueCode = Math.floor(101 + Math.random() * 898);
          finalAmount = pricing.final_price + uniqueCode;
        }

        const txId = generateId("tx");
        const orderCode = `OBV-${Date.now().toString().slice(-6)}${Math.floor(10 + Math.random() * 89)}`;
        const ttlMinutes = parseInt(env.CHECKOUT_TTL_MINUTES || "15", 10);
        const expiresAt = Date.now() + ttlMinutes * 60 * 1000;

        await env.DB.prepare(
          `INSERT INTO transactions 
          (id, order_code, product_id, buyer_name, buyer_contact, base_price, discount_amount, unique_code, final_amount, status, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`
        )
          .bind(
            txId,
            orderCode,
            product.id,
            body.buyer_name || "Guest",
            body.buyer_contact || "-",
            pricing.original_price,
            pricing.discount_amount,
            uniqueCode,
            finalAmount,
            expiresAt
          )
          .run();

        return jsonResponse({
          transaction: {
            id: txId,
            order_code: orderCode,
            product_title: product.title,
            product_category: product.category,
            product_subcategory: product.subcategory,
            original_price: pricing.original_price,
            discount_amount: pricing.discount_amount,
            discounted_price: pricing.final_price,
            unique_code: uniqueCode,
            final_amount: finalAmount,
            status: "PENDING",
            expires_at: expiresAt,
            qris_image_url:
              product.qris_image_url ||
              env.DEFAULT_QRIS_IMAGE ||
              "https://upload.wikimedia.org/wikipedia/commons/d/d0/QR_code_for_mobile_English_Wikipedia.svg",
          },
        });
      }

      // ==========================================
      // 7. POLLING STATUS TRANSAKSI
      // ==========================================
      if (path.startsWith("/api/transactions/") && request.method === "GET") {
        const orderCode = path.split("/").pop();
        const tx = await env.DB.prepare(
          `SELECT t.*, p.title AS product_title, p.category AS product_category, 
                  p.subcategory AS product_subcategory, p.qris_image_url
           FROM transactions t
           JOIN products p ON t.product_id = p.id
           WHERE t.order_code = ?`
        )
          .bind(orderCode)
          .first();

        if (!tx) return jsonResponse({ error: "Transaksi tidak ditemukan." }, 404);

        if (tx.status === "PENDING" && Date.now() > tx.expires_at) {
          await env.DB.prepare("UPDATE transactions SET status = 'EXPIRED' WHERE id = ?")
            .bind(tx.id)
            .run();
          tx.status = "EXPIRED";
        }

        return jsonResponse({
          transaction: {
            order_code: tx.order_code,
            product_title: tx.product_title,
            product_category: tx.product_category,
            product_subcategory: tx.product_subcategory,
            original_price: tx.base_price,
            discount_amount: tx.discount_amount,
            discounted_price: tx.base_price - tx.discount_amount,
            unique_code: tx.unique_code,
            final_amount: tx.final_amount,
            status: tx.status,
            expires_at: tx.expires_at,
            download_token: tx.status === "PAID" ? tx.download_token : null,
            qris_image_url:
              tx.qris_image_url ||
              env.DEFAULT_QRIS_IMAGE ||
              "https://upload.wikimedia.org/wikipedia/commons/d/d0/QR_code_for_mobile_English_Wikipedia.svg",
          },
        });
      }

      // ==========================================
      // 8. PAYMENT WEBHOOK (SAWERIA / SOCIABUZZ / TRAKTEER / MACRODROID)
      // ==========================================
      if (path === "/api/webhook/payment" && request.method === "POST") {
        // Opsional verifikasi secret token lewat query ?token=... atau header
        const queryToken = url.searchParams.get("token");
        const headerToken = request.headers.get("X-Webhook-Token");
        if (env.WEBHOOK_SECRET) {
          if (queryToken !== env.WEBHOOK_SECRET && headerToken !== env.WEBHOOK_SECRET) {
            return jsonResponse({ error: "Invalid webhook token" }, 401);
          }
        }

        const rawBody = await request.text();
        let payload = {};
        try {
          payload = JSON.parse(rawBody);
        } catch {
          payload = { text: rawBody };
        }

        // Ekstrak nominal dari berbagai format payload (Saweria: amount_raw, SociaBuzz: amount, MacroDroid: text/message)
        let incomingAmount = Number(
          payload.amount_raw || payload.amount || payload.price || payload.nominal || 0
        );
        const messageText = String(
          payload.message || payload.note || payload.text || payload.content || ""
        );

        // Jika nominal tidak eksplisit, ekstrak angka dari teks notifikasi (misal dari MacroDroid notifikasi Dana/GoPay/QRIS)
        if (!incomingAmount && messageText) {
          const digits = messageText.replace(/[^0-9]/g, "");
          if (digits) incomingAmount = Number(digits);
        }

        // Cari order_code jika pembeli menuliskannya di pesan dukungan Saweria/SociaBuzz
        const orderMatch = messageText.match(/OBV-[0-9]{8}/i);
        let matchedTx = null;

        if (orderMatch) {
          matchedTx = await env.DB.prepare(
            "SELECT * FROM transactions WHERE order_code = ? AND status = 'PENDING'"
          )
            .bind(orderMatch[0].toUpperCase())
            .first();
        }

        // Jika tidak ada order_code di pesan, cocokkan berdasarkan NOMINAL UNIK (final_amount) yang masih PENDING & belum expired
        if (!matchedTx && incomingAmount > 0) {
          matchedTx = await env.DB.prepare(
            "SELECT * FROM transactions WHERE final_amount = ? AND status = 'PENDING' AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
          )
            .bind(incomingAmount, Date.now())
            .first();
        }

        if (!matchedTx) {
          return jsonResponse({
            received: true,
            matched: false,
            message: "Tidak ada transaksi PENDING yang cocok dengan nominal/kode tersebut.",
          });
        }

        const downloadToken = crypto.randomUUID();
        await env.DB.prepare(
          "UPDATE transactions SET status = 'PAID', download_token = ?, paid_at = datetime('now') WHERE id = ?"
        )
          .bind(downloadToken, matchedTx.id)
          .run();

        return jsonResponse({
          received: true,
          matched: true,
          order_code: matchedTx.order_code,
        });
      }

      // ==========================================
      // 9. PROTECTED DOWNLOAD DENGAN TOKEN
      // ==========================================
      if (path.startsWith("/api/download/") && request.method === "GET") {
        const token = path.split("/").pop();
        const tx = await env.DB.prepare(
          `SELECT t.*, p.file_key, p.file_name, p.file_url_fallback, p.title
           FROM transactions t
           JOIN products p ON t.product_id = p.id
           WHERE t.download_token = ? AND t.status = 'PAID'`
        )
          .bind(token)
          .first();

        if (!tx) {
          return jsonResponse({ error: "Token download tidak valid atau belum dibayar." }, 403);
        }

        if (tx.file_key && env.BUCKET) {
          const obj = await env.BUCKET.get(tx.file_key);
          if (obj) {
            const headers = new Headers(CORS_HEADERS);
            headers.set(
              "Content-Disposition",
              `attachment; filename="${tx.file_name || "oblivionstore-product.zip"}"`
            );
            headers.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
            return new Response(obj.body, { headers });
          }
        }

        if (tx.file_url_fallback) {
          return Response.redirect(tx.file_url_fallback, 302);
        }

        return jsonResponse({
          message: `Pembayaran terverifikasi untuk ${tx.title}. Silakan hubungi admin dengan kode order ${tx.order_code} untuk klaim layanan Jasa/file.`,
        });
      }

      // ==========================================
      // 10. PUBLIC R2 ASSET VIEWER (THUMBNAIL / QRIS / TESTI)
      // ==========================================
      if (path.startsWith("/api/assets/") && request.method === "GET") {
        if (!env.BUCKET) return jsonResponse({ error: "R2 tidak aktif" }, 404);
        const key = decodeURIComponent(path.replace("/api/assets/", ""));
        const obj = await env.BUCKET.get(key);
        if (!obj) return jsonResponse({ error: "Asset tidak ditemukan" }, 404);

        const headers = new Headers(CORS_HEADERS);
        headers.set("Content-Type", obj.httpMetadata?.contentType || "image/png");
        headers.set("Cache-Control", "public, max-age=86400");
        return new Response(obj.body, { headers });
      }

      // =========================================================================
      // ADMIN PROTECTED ROUTES (MEMERLUKAN HEADER AUTHORIZATION: Bearer <PASS>)
      // =========================================================================
      if (path.startsWith("/api/admin/")) {
        const isAuthed = await verifyAdmin(request, env);
        if (!isAuthed) {
          return jsonResponse({ error: "Unauthorized. Login admin diperlukan." }, 401);
        }

        // --- UPLOAD FILE KE R2 ---
        if (path === "/api/admin/upload" && request.method === "POST") {
          if (!env.BUCKET) {
            return jsonResponse(
              {
                error:
                  "R2 Storage belum diaktifkan di wrangler.toml. Gunakan kolom URL Gambar / URL File eksternal.",
              },
              400
            );
          }

          const formData = await request.formData();
          const file = formData.get("file");
          const folder = formData.get("folder") || "uploads";

          if (!file || typeof file === "string") {
            return jsonResponse({ error: "File tidak ditemukan dalam form." }, 400);
          }

          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const key = `${folder}/${Date.now()}-${safeName}`;

          await env.BUCKET.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || "application/octet-stream" },
          });

          const publicAssetUrl = `${url.origin}/api/assets/${encodeURIComponent(key)}`;
          return jsonResponse({
            success: true,
            key,
            file_name: file.name,
            url: publicAssetUrl,
          });
        }

        // --- CRUD PRODUK ---
        if (path === "/api/admin/products" && request.method === "GET") {
          const { results } = await env.DB.prepare(
            "SELECT * FROM products ORDER BY created_at DESC"
          ).all();
          return jsonResponse({ products: results });
        }

        if (path === "/api/admin/products" && request.method === "POST") {
          const b = await request.json();
          const id = generateId("prod");
          const subcat = b.category === "Minecraft" ? b.subcategory || "Plugin" : null;

          await env.DB.prepare(
            `INSERT INTO products (id, title, description, category, subcategory, is_free, price, thumbnail_url, file_key, file_name, file_url_fallback, qris_image_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              id,
              b.title,
              b.description,
              b.category,
              subcat,
              b.is_free ? 1 : 0,
              b.is_free ? 0 : Number(b.price || 0),
              b.thumbnail_url || "",
              b.file_key || "",
              b.file_name || "",
              b.file_url_fallback || "",
              b.qris_image_url || ""
            )
            .run();

          return jsonResponse({ success: true, id });
        }

        if (path.startsWith("/api/admin/products/") && request.method === "PUT") {
          const id = path.split("/").pop();
          const b = await request.json();
          const subcat = b.category === "Minecraft" ? b.subcategory || "Plugin" : null;

          await env.DB.prepare(
            `UPDATE products SET title=?, description=?, category=?, subcategory=?, is_free=?, price=?, 
             thumbnail_url=?, file_key=?, file_name=?, file_url_fallback=?, qris_image_url=?, updated_at=datetime('now')
             WHERE id=?`
          )
            .bind(
              b.title,
              b.description,
              b.category,
              subcat,
              b.is_free ? 1 : 0,
              b.is_free ? 0 : Number(b.price || 0),
              b.thumbnail_url || "",
              b.file_key || "",
              b.file_name || "",
              b.file_url_fallback || "",
              b.qris_image_url || "",
              id
            )
            .run();

          return jsonResponse({ success: true });
        }

        if (path.startsWith("/api/admin/products/") && request.method === "DELETE") {
          const id = path.split("/").pop();
          await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
          return jsonResponse({ success: true });
        }

        // --- CRUD DISKON ---
        if (path === "/api/admin/discounts" && request.method === "GET") {
          const { results } = await env.DB.prepare(
            "SELECT * FROM discounts ORDER BY created_at DESC"
          ).all();
          return jsonResponse({ discounts: results });
        }

        if (path === "/api/admin/discounts" && request.method === "POST") {
          const b = await request.json();
          const id = generateId("disc");
          await env.DB.prepare(
            `INSERT INTO discounts (id, name, discount_type, discount_value, scope, product_id, active)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              id,
              b.name,
              b.discount_type,
              Number(b.discount_value),
              b.scope,
              b.scope === "product" ? b.product_id : null,
              b.active !== false ? 1 : 0
            )
            .run();
          return jsonResponse({ success: true, id });
        }

        if (path.startsWith("/api/admin/discounts/") && request.method === "DELETE") {
          const id = path.split("/").pop();
          await env.DB.prepare("DELETE FROM discounts WHERE id = ?").bind(id).run();
          return jsonResponse({ success: true });
        }

        // --- CRUD PORTOFOLIO (ATURAN KHUSUS: TAMBAH HANYA 1X, EDIT BEBAS) ---
        if (path === "/api/admin/portfolio" && request.method === "POST") {
          const countRow = await env.DB.prepare(
            "SELECT COUNT(*) as total FROM portfolio"
          ).first();
          if (countRow && countRow.total >= 1) {
            return jsonResponse(
              {
                error:
                  "Batas pembuatan portofolio tercapai (maksimal 1x tambah). Silakan edit portofolio yang sudah ada.",
              },
              403
            );
          }

          const b = await request.json();
          const id = generateId("port");
          await env.DB.prepare(
            "INSERT INTO portfolio (id, title, category, description, image_url, project_url) VALUES (?, ?, ?, ?, ?, ?)"
          )
            .bind(id, b.title, b.category, b.description, b.image_url || "", b.project_url || "")
            .run();

          return jsonResponse({ success: true, id });
        }

        if (path.startsWith("/api/admin/portfolio/") && request.method === "PUT") {
          const id = path.split("/").pop();
          const b = await request.json();
          await env.DB.prepare(
            "UPDATE portfolio SET title=?, category=?, description=?, image_url=?, project_url=?, updated_at=datetime('now') WHERE id=?"
          )
            .bind(b.title, b.category, b.description, b.image_url || "", b.project_url || "", id)
            .run();
          return jsonResponse({ success: true });
        }

        // --- CRUD TESTIMONI ---
        if (path === "/api/admin/testimonials" && request.method === "POST") {
          const b = await request.json();
          const id = generateId("testi");
          await env.DB.prepare(
            "INSERT INTO testimonials (id, customer_name, customer_role, rating, description, photo_url) VALUES (?, ?, ?, ?, ?, ?)"
          )
            .bind(
              id,
              b.customer_name,
              b.customer_role || "Pembeli",
              Number(b.rating || 5),
              b.description,
              b.photo_url || ""
            )
            .run();
          return jsonResponse({ success: true, id });
        }

        if (path.startsWith("/api/admin/testimonials/") && request.method === "PUT") {
          const id = path.split("/").pop();
          const b = await request.json();
          await env.DB.prepare(
            "UPDATE testimonials SET customer_name=?, customer_role=?, rating=?, description=?, photo_url=? WHERE id=?"
          )
            .bind(
              b.customer_name,
              b.customer_role || "Pembeli",
              Number(b.rating || 5),
              b.description,
              b.photo_url || "",
              id
            )
            .run();
          return jsonResponse({ success: true });
        }

        if (path.startsWith("/api/admin/testimonials/") && request.method === "DELETE") {
          const id = path.split("/").pop();
          await env.DB.prepare("DELETE FROM testimonials WHERE id = ?").bind(id).run();
          return jsonResponse({ success: true });
        }

        // --- TRANSAKSI & KONFIRMASI MANUAL ADMIN ---
        if (path === "/api/admin/transactions" && request.method === "GET") {
          const { results } = await env.DB.prepare(
            `SELECT t.*, p.title as product_title 
             FROM transactions t 
             LEFT JOIN products p ON t.product_id = p.id 
             ORDER BY t.created_at DESC LIMIT 50`
          ).all();
          return jsonResponse({ transactions: results });
        }

        if (path.startsWith("/api/admin/transactions/") && path.endsWith("/confirm") && request.method === "POST") {
          const parts = path.split("/");
          const orderCode = parts[parts.length - 2];
          const downloadToken = crypto.randomUUID();

          await env.DB.prepare(
            "UPDATE transactions SET status = 'PAID', download_token = ?, paid_at = datetime('now') WHERE order_code = ?"
          )
            .bind(downloadToken, orderCode)
            .run();

          return jsonResponse({ success: true, download_token: downloadToken });
        }
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message || "Internal Server Error" }, 500);
    }
  },
};
