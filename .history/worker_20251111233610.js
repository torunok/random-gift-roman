// worker.js — stable version (no duration field)

let schemaReadyPromise = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const isPreflight = request.method === "OPTIONS";
    const cors = makeCORSHeaders(origin, env);

    // === Preflight ===
    if (isPreflight) return new Response(null, { status: 204, headers: cors });

    // === Static imageUrls from R2 ===
    if (url.pathname.startsWith("/img/")) {
      try {
        const key = url.pathname.replace(/^\/img\//, "");
        const obj = await env.R2.get(key);
        if (!obj) return new Response("Not found", { status: 404, headers: cors });
        const ct = obj.httpMetadata?.contentType || guessContentTypeByKey(key) || "application/octet-stream";
        return new Response(obj.body, {
          status: 200,
          headers: { ...cors, "Content-Type": ct, "Cache-Control": "public, max-age=31536000, immutable" },
        });
      } catch (e) {
        console.error("R2 error:", e);
        return new Response("R2 error: " + (e?.message || e), { status: 500, headers: cors });
      }
    }

    try {
      // гарантуємо наявність таблиць
      await ensureSchema(env);

      // === RANDOM API ===
      if (url.pathname === "/api/random" && request.method === "GET") {
        const ipHash = await getIpHash(request, env.SALT);
        const ua = request.headers.get("User-Agent") || "";
        console.log("random:start", { ipHash: ipHash.slice(0, 12), ua });

        // якщо вже є призначення
        const existing = await env.random_gift_db_v2.prepare("SELECT giftId FROM assignments WHERE ipHash = ?").bind(ipHash).first();
        if (existing?.giftId) {
          const gift = await env.random_gift_db_v2.prepare("SELECT id, title, description, imageUrl FROM gifts WHERE id = ?")
            .bind(existing.giftId)
            .first();
          return json({ already: true, gift }, cors);
        }

        const lockKey = "lock:random";
        const gotLock = await tryLock(env, lockKey, 60);
        if (!gotLock) return json({ error: "busy" }, cors, 429);

        try {
          await env.random_gift_db_v2.exec("BEGIN IMMEDIATE");

          // вибір випадкового подарунку зі stock>0
          const pick = await env.random_gift_db_v2.prepare(
            "SELECT id, title, description, imageUrl FROM gifts WHERE stock > 0 ORDER BY RANDOM() LIMIT 1"
          ).first();
          if (!pick) {
            await env.random_gift_db_v2.exec("ROLLBACK");
            return json({ error: "no_stock" }, cors, 409);
          }

          await env.random_gift_db_v2.prepare("UPDATE gifts SET stock = stock - 1 WHERE id = ? AND stock > 0")
            .bind(pick.id)
            .run();

          await env.random_gift_db_v2.prepare("INSERT INTO assignments(ipHash, giftId) VALUES(?, ?)").bind(ipHash, pick.id).run();
          await env.random_gift_db_v2.prepare("INSERT INTO logs(ipHash, action) VALUES(?, 'random')").bind(ipHash).run();

          await env.random_gift_db_v2.exec("COMMIT");
          console.log("random:tx_commit", pick.id);

          return json({ gift: pick }, cors);
        } catch (e) {
          console.error("random:error", e?.message || e);
          try {
            await env.random_gift_db_v2.exec("ROLLBACK");
          } catch {}
          return json({ error: String(e?.message || e) }, cors, 500);
        } finally {
          await unlock(env, lockKey);
          console.log("random:unlock");
        }
      }

      // === DEFAULT ===
      return json({ error: "not_found" }, cors, 404);
    } catch (e) {
      console.error("UNCAUGHT", e?.stack || e?.message || e);
      return json({ error: String(e?.message || e) }, cors, 500);
    }
  },
};

/* ====== HELPERS ====== */
function makeCORSHeaders(origin, env) {
  const allow = env.ALLOWED_ORIGIN || "";
  const ok = allow && origin === allow;
  return {
    "Access-Control-Allow-Origin": ok ? allow : "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
  };
}
function json(data, cors = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
function guessContentTypeByKey(key) {
  const k = key.toLowerCase();
  if (k.endsWith(".jpg") || k.endsWith(".jpeg")) return "image/jpeg";
  if (k.endsWith(".png")) return "image/png";
  if (k.endsWith(".webp")) return "image/webp";
  if (k.endsWith(".txt")) return "text/plain; charset=utf-8";
  return null;
}

/* ====== SCHEMA INIT ====== */
async function ensureSchema(env) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      // створюємо таблиці, якщо немає
      await env.random_gift_db_v2.exec(`
        CREATE TABLE IF NOT EXISTS gifts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT,
          description TEXT,
          imageUrl TEXT,
          stock INTEGER DEFAULT 1
        );
      `);
      await env.random_gift_db_v2.exec(`
        CREATE TABLE IF NOT EXISTS assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ipHash TEXT,
          giftId INTEGER,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await env.random_gift_db_v2.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ipHash TEXT,
          action TEXT,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
    })();
  }
  return schemaReadyPromise;
}

/* ====== LOCKS & UTILS ====== */
async function getIpHash(request, salt) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "0.0.0.0";
  const msg = new TextEncoder().encode(ip + (salt || ""));
  const digest = await crypto.subtle.digest("SHA-256", msg);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function tryLock(env, key, ttlSeconds) {
  const exists = await env.KV.get(key);
  if (exists) return false;
  await env.KV.put(key, "1", { expirationTtl: ttlSeconds || 60 });
  return true;
}
async function unlock(env, key) {
  await env.KV.delete(key);
}
