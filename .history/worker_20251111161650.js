let giftSchemaReadyPromise = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const isPreflight = request.method === "OPTIONS";
    const corsHeaders = makeCORSHeaders(origin, env);

    // ===== R2: статичні зображення =====
    if (url.pathname.startsWith("/img/")) {
      try {
        const key = url.pathname.replace(/^\/img\//, "");
        const obj = await env.R2.get(key);
        if (!obj) return new Response("Not found", { status: 404, headers: corsHeaders });
        const ct = obj.httpMetadata?.contentType || guessContentTypeByKey(key) || "application/octet-stream";
        return new Response(obj.body, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": ct,
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      } catch (e) {
        console.error("R2 error:", e);
        return new Response("R2 error: " + (e?.message || e), { status: 500, headers: corsHeaders });
      }
    }

    if (isPreflight) return new Response(null, { status: 204, headers: corsHeaders });

    try {
      await ensureGiftSchema(env);

      // ===== ПУБЛІЧНІ API =====

      if (url.pathname === "/api/random" && request.method === "GET") {
        const ipHash = await getIpHash(request, env.SALT);
        const ua = request.headers.get("User-Agent") || "";
        console.log("random:start", { ipHash: ipHash.slice(0, 12), ua });

        // перевірка існуючого призначення
        const existing = await env.DB.prepare("SELECT giftId FROM assignments WHERE ipHash = ?")
          .bind(ipHash)
          .first();

        if (existing?.giftId) {
          const gift = await env.DB.prepare("SELECT id, name, description, image FROM gifts WHERE id = ?")
            .bind(existing.giftId)
            .first();
          return json({ already: true, gift }, corsHeaders);
        }

        const lockKey = `lock:random`;
        const gotLock = await tryLock(env, lockKey, 90);
        if (!gotLock) return json({ error: "busy" }, corsHeaders, 429);

        try {
          await env.DB.exec("BEGIN IMMEDIATE");

          const pick = await env.DB.prepare(
            "SELECT id, name, description, image FROM gifts WHERE stock > 0 ORDER BY RANDOM() LIMIT 1"
          ).first();

          if (!pick) {
            await env.DB.exec("ROLLBACK");
            return json({ error: "no_stock" }, corsHeaders, 409);
          }

          await env.DB.prepare("UPDATE gifts SET stock = stock - 1 WHERE id = ? AND stock > 0")
            .bind(pick.id)
            .run();

          await env.DB.prepare("INSERT INTO assignments(ipHash, giftId) VALUES(?, ?)").bind(ipHash, pick.id).run();
          await env.DB.prepare("INSERT INTO logs(ipHash, action) VALUES(?, 'random')").bind(ipHash).run();

          await env.DB.exec("COMMIT");
          console.log("random:tx_commit", pick.id);

          return json({ gift: pick }, corsHeaders);
        } catch (e) {
          console.error("random:error", e?.message || e);
          try {
            await env.DB.exec("ROLLBACK");
          } catch (er2) {
            console.error("random:rollback_error", er2);
          }
          return json({ error: String(e?.message || e) }, corsHeaders, 500);
        } finally {
          await unlock(env, lockKey);
          console.log("random:unlock");
        }
      }

      return json({ error: "not_found" }, corsHeaders, 404);
    } catch (e) {
      console.error("UNCAUGHT", e?.stack || e?.message || e);
      return json({ error: String(e?.message || e) }, corsHeaders, 500);
    }
  },
};

/* ===== Helpers ===== */
function makeCORSHeaders(origin, env) {
  const allow = env.ALLOWED_ORIGIN || "";
  const ok = allow && origin === allow;
  return {
    "Access-Control-Allow-Origin": ok ? allow : "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
  };
}
function json(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}
function guessContentTypeByKey(key) {
  const k = key.toLowerCase();
  if (k.endsWith(".jpg") || k.endsWith(".jpeg")) return "image/jpeg";
  if (k.endsWith(".png")) return "image/png";
  if (k.endsWith(".webp")) return "image/webp";
  if (k.endsWith(".txt")) return "text/plain; charset=utf-8";
  return null;
}

/* ===== Schema guard ===== */
async function ensureGiftSchema(env) {
  if (!giftSchemaReadyPromise) {
    giftSchemaReadyPromise = (async () => {
      try {
        await env.DB.prepare("SELECT id, name, duration, stock FROM gifts LIMIT 1").first();
      } catch (err) {
        const msg = String(err?.message || "");
        if (/no such column/i.test(msg)) {
          console.warn("ensureGiftSchema: adding missing columns if needed");
          await safeAlter(env, "ALTER TABLE gifts ADD COLUMN duration INTEGER DEFAULT 0;");
          await safeAlter(env, "ALTER TABLE gifts ADD COLUMN stock INTEGER DEFAULT 1;");
        } else throw err;
      }
    })();
  }
  return giftSchemaReadyPromise;
}
async function safeAlter(env, sql) {
  try {
    await env.DB.prepare(sql).run();
  } catch (e) {
    const msg = String(e?.message || "");
    if (!/duplicate column|already exists/i.test(msg)) console.error("safeAlter failed:", msg);
  }
}

/* ===== Locks & utils ===== */
async function getIpHash(request, salt) {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "0.0.0.0";
  const msg = new TextEncoder().encode(ip + (salt || ""));
  const digest = await crypto.subtle.digest("SHA-256", msg);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function tryLock(env, key, ttlSeconds) {
  const ttl = Math.max(Number(ttlSeconds) || 0, 60);
  const exists = await env.KV.get(key);
  if (exists) return false;
  await env.KV.put(key, "1", { expirationTtl: ttl });
  return true;
}
async function unlock(env, key) {
  await env.KV.delete(key);
}
