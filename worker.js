// worker.js — full API (public + admin)

let schemaReadyPromise = null;
const jwtKeyCache = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = makeCORSHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Static assets from R2
    if (url.pathname.startsWith("/img/")) {
      return serveImageFromR2(url, env, cors);
    }

    let db;
    try {
      db = getDatabase(env);
      await ensureSchema(db);
    } catch (e) {
      console.error("schema/init error", e?.stack || e);
      return json({ error: e?.message || String(e) }, cors, 500);
    }

    try {
      if (url.pathname === "/api/agree" && request.method === "POST") {
        return await handleAgree(request, env, cors, db);
      }
      if (url.pathname === "/api/me" && request.method === "GET") {
        return await handleMe(request, env, cors, db);
      }
      if (url.pathname === "/api/random" && request.method === "GET") {
        return await handleRandom(request, env, cors, db);
      }
      if (url.pathname === "/api/finalize" && request.method === "POST") {
        return await handleFinalize(request, env, cors, db);
      }
      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        return await handleAdminLogin(request, env, cors);
      }
      if (url.pathname.startsWith("/api/admin/")) {
        return await handleAdminRoutes(url, request, env, cors, db);
      }

      return json({ error: "not_found" }, cors, 404);
    } catch (e) {
      console.error("UNCAUGHT", e?.stack || e);
      const status = e?.status || e?.statusCode || 500;
      return json({ error: e?.message || String(e) }, cors, status);
    }
  },
};

/* ========= ROUTES ========= */
async function handleAgree(request, env, cors, db) {
  const body = await readJson(request);
  const name = sanitizeName(body?.name);
  const ipHash = await getIpHash(request, env.SALT);

  const existing = await getAssignmentByHash(db, ipHash);
  if (existing) {
    await db.prepare("UPDATE assignments SET name = ? WHERE id = ?").bind(name, existing.id).run();
  } else {
    await db.prepare("INSERT INTO assignments (ipHash, name) VALUES (?, ?)").bind(ipHash, name).run();
  }
  await logAction(db, ipHash, "agree");

  return json({ ok: true }, cors);
}

async function handleMe(request, env, cors, db) {
  const ipHash = await getIpHash(request, env.SALT);
  const row = await db
    .prepare(
      `
        SELECT a.id, a.name, a.telegram, a.giftId,
               g.title, g.description, g.imageUrl
        FROM assignments a
        LEFT JOIN gifts g ON g.id = a.giftId
        WHERE a.ipHash = ?
        ORDER BY a.id DESC
        LIMIT 1
      `
    )
    .bind(ipHash)
    .first();

  if (!row) {
    return json({ assigned: false }, cors);
  }

  const assigned = !!row.giftId;
  return json(
    {
      assigned,
      telegram: row.telegram || "",
      name: row.name || "",
      gift: assigned ? mapGiftForClient({ id: row.giftId, title: row.title, description: row.description, imageUrl: row.imageUrl }) : null,
    },
    cors
  );
}

async function handleFinalize(request, env, cors, db) {
  const body = await readJson(request);
  const telegram = sanitizeTelegram(body?.telegram);
  const ipHash = await getIpHash(request, env.SALT);

  const assignment = await db
    .prepare("SELECT id, giftId FROM assignments WHERE ipHash = ? ORDER BY id DESC LIMIT 1")
    .bind(ipHash)
    .first();
  if (!assignment || !assignment.giftId) {
    throw httpError(409, "gift_not_assigned");
  }

  await db.prepare("UPDATE assignments SET telegram = ? WHERE id = ?").bind(telegram, assignment.id).run();
  await logAction(db, ipHash, "finalize");

  return json({ ok: true }, cors);
}

async function handleRandom(request, env, cors, db) {
  const ipHash = await getIpHash(request, env.SALT);
  const ua = request.headers.get("User-Agent") || "";
  console.log("random:start", { ipHash: ipHash.slice(0, 12), ua });

  const existing = await db
    .prepare(
      `
        SELECT a.id, a.giftId,
               g.title, g.description, g.imageUrl
        FROM assignments a
        LEFT JOIN gifts g ON g.id = a.giftId
        WHERE a.ipHash = ?
        ORDER BY a.id DESC
        LIMIT 1
      `
    )
    .bind(ipHash)
    .first();

  if (existing?.giftId) {
    return json({ already: true, gift: mapGiftForClient({ id: existing.giftId, title: existing.title, description: existing.description, imageUrl: existing.imageUrl }) }, cors);
  }

  const lockKey = "lock:random";
  const gotLock = await tryLock(env, lockKey, 60);
  if (!gotLock) return json({ error: "busy" }, cors, 429);

  try {
    await begin(db);

    const pick = await db
      .prepare("SELECT id, title, description, imageUrl FROM gifts WHERE active = 1 AND stock > 0 ORDER BY RANDOM() LIMIT 1")
      .first();
    if (!pick) {
      await rollback(db);
      return json({ error: "no_stock" }, cors, 409);
    }

    const updateRes = await db.prepare("UPDATE gifts SET stock = stock - 1 WHERE id = ? AND stock > 0").bind(pick.id).run();
    if (!updateRes.success || updateRes.meta.changes !== 1) {
      await rollback(db);
      return json({ error: "no_stock" }, cors, 409);
    }

    if (existing) {
      await db.prepare("UPDATE assignments SET giftId = ? WHERE id = ?").bind(pick.id, existing.id).run();
    } else {
      await db.prepare("INSERT INTO assignments(ipHash, giftId) VALUES(?, ?)").bind(ipHash, pick.id).run();
    }

    await run(db, "INSERT INTO logs(ipHash, action) VALUES(?, 'random')", [ipHash]);
    await commit(db);
    console.log("random:tx_commit", pick.id);

    return json({ gift: mapGiftForClient(pick) }, cors);
  } catch (e) {
    console.error("random:error", e?.message || e);
    await rollback(db);
    return json({ error: String(e?.message || e) }, cors, 500);
  } finally {
    await unlock(env, lockKey);
    console.log("random:unlock");
  }
}

async function handleAdminLogin(request, env, cors) {
  const body = await readJson(request);
  const username = (body?.username || "").trim();
  const password = body?.password || "";

  if (!env.ADMIN_USER || !env.ADMIN_PASS || !env.JWT_SECRET) {
    throw new Error("Admin credentials not configured");
  }

  if (username !== env.ADMIN_USER || password !== env.ADMIN_PASS) {
    throw httpError(401, "invalid_credentials");
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await createJwt(
    { sub: username, role: "admin", iat: now, exp: now + 60 * 60 * 12 }, // 12h
    env.JWT_SECRET
  );
  return json({ token }, cors);
}

async function handleAdminRoutes(url, request, env, cors, db) {
  const admin = await requireAdmin(request, env.JWT_SECRET);
  if (!admin || admin.role !== "admin") {
    throw httpError(401, "unauthorized");
  }

  if (url.pathname === "/api/admin/gifts") {
    return handleAdminGifts(url, request, cors, db);
  }
  if (url.pathname === "/api/admin/assignments") {
    return handleAdminAssignments(url, request, cors, db);
  }
  if (url.pathname === "/api/admin/upload" && request.method === "POST") {
    return handleAdminUpload(request, env, cors);
  }

  return json({ error: "not_found" }, cors, 404);
}

async function handleAdminGifts(url, request, cors, db) {
  const method = request.method.toUpperCase();

  if (method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      const item = await db.prepare("SELECT id, title, description, imageUrl, active, stock FROM gifts WHERE id = ?").bind(Number(id)).first();
      return json({ item }, cors);
    }
    const { results } = await db.prepare("SELECT id, title, description, imageUrl, active, stock FROM gifts ORDER BY id DESC").all();
    return json({ items: results || [] }, cors);
  }

  if (method === "POST" || method === "PUT") {
    const payload = await readJson(request);
    const fields = normalizeGiftPayload(payload);

    if (method === "POST") {
      const res = await db
        .prepare("INSERT INTO gifts(title, description, imageUrl, active, stock) VALUES(?, ?, ?, ?, ?)")
        .bind(fields.title, fields.description, fields.imageUrl, fields.active, fields.stock)
        .run();
      return json({ ok: res.success }, cors);
    } else {
      const id = Number(url.searchParams.get("id"));
      if (!id) throw httpError(400, "id_required");
      const res = await db
        .prepare("UPDATE gifts SET title = ?, description = ?, imageUrl = ?, active = ?, stock = ? WHERE id = ?")
        .bind(fields.title, fields.description, fields.imageUrl, fields.active, fields.stock, id)
        .run();
      return json({ ok: res.success }, cors);
    }
  }

  if (method === "DELETE") {
    const id = Number(url.searchParams.get("id"));
    if (!id) throw httpError(400, "id_required");
    await db.prepare("DELETE FROM gifts WHERE id = ?").bind(id).run();
    return json({ ok: true }, cors);
  }

  throw httpError(405, "method_not_allowed");
}

async function handleAdminAssignments(url, request, cors, db) {
  const method = request.method.toUpperCase();

  if (method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    let stmt = `
      SELECT a.id, a.name, a.telegram, a.giftId, a.createdAt
      FROM assignments a
      LEFT JOIN gifts g ON g.id = a.giftId
    `;
    const binds = [];
    if (q) {
      stmt += " WHERE a.name LIKE ? OR a.telegram LIKE ? OR g.title LIKE ?";
      const like = `%${q}%`;
      binds.push(like, like, like);
    }
    stmt += " ORDER BY a.id DESC LIMIT 200";

    const prepared = db.prepare(stmt);
    const result = binds.length ? await prepared.bind(...binds).all() : await prepared.all();
    return json({ items: result.results || [] }, cors);
  }

  if (method === "DELETE") {
    const id = Number(url.searchParams.get("id"));
    if (!id) throw httpError(400, "id_required");
    const row = await db.prepare("SELECT giftId FROM assignments WHERE id = ?").bind(id).first();
    await db.prepare("DELETE FROM assignments WHERE id = ?").bind(id).run();
    if (row?.giftId) {
      await db.prepare("UPDATE gifts SET stock = stock + 1 WHERE id = ?").bind(row.giftId).run();
    }
    return json({ ok: true }, cors);
  }

  throw httpError(405, "method_not_allowed");
}

async function handleAdminUpload(request, env, cors) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") {
    throw httpError(400, "file_required");
  }

  if (!env.R2) {
    throw new Error("R2 binding missing");
  }

  const arrayBuffer = await file.arrayBuffer();
  const ext = guessExt(file.name || "");
  const key = `uploads/${Date.now()}-${crypto.randomUUID?.() || cryptoRandomString()}${ext}`;

  await env.R2.put(key, arrayBuffer, {
    httpMetadata: { contentType: file.type || guessContentTypeByKey(key) || "application/octet-stream" },
  });

  return json({ url: `/img/${key}` }, cors);
}

/* ========= HELPERS ========= */
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

function json(data, cors = {}, status = 200) {
  return new Response(JSON.stringify(data ?? {}), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

async function serveImageFromR2(url, env, cors) {
  if (!env.R2) return json({ error: "R2_not_configured" }, cors, 500);
  const key = url.pathname.replace(/^\/img\//, "");
  try {
    const obj = await env.R2.get(key);
    if (!obj) {
      return new Response("Not found", { status: 404, headers: cors });
    }
    const ct = obj.httpMetadata?.contentType || guessContentTypeByKey(key) || "application/octet-stream";
    return new Response(obj.body, {
      status: 200,
      headers: { ...cors, "Content-Type": ct, "Cache-Control": "public, max-age=31536000, immutable" },
    });
  } catch (e) {
    console.error("R2 error:", e);
    return new Response("R2 error", { status: 500, headers: cors });
  }
}

function guessContentTypeByKey(key) {
  const k = key.toLowerCase();
  if (k.endsWith(".jpg") || k.endsWith(".jpeg")) return "image/jpeg";
  if (k.endsWith(".png")) return "image/png";
  if (k.endsWith(".webp")) return "image/webp";
  if (k.endsWith(".gif")) return "image/gif";
  if (k.endsWith(".txt")) return "text/plain; charset=utf-8";
  return null;
}

function guessExt(name) {
  const lower = (name || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function mapGiftForClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    imageUrl: row.imageUrl || "",
    active: row.active,
    stock: row.stock,
    name: row.title || "",
    image: row.imageUrl || "",
  };
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "invalid_json");
  }
}

async function ensureSchema(db) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await execSql(
        db,
        `
        CREATE TABLE IF NOT EXISTS gifts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT,
          imageUrl TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          stock INTEGER NOT NULL DEFAULT 1,
          createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ipHash TEXT NOT NULL,
          name TEXT,
          telegram TEXT,
          giftId INTEGER,
          createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ipHash TEXT,
          action TEXT,
          createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_assignments_ip ON assignments(ipHash);
        CREATE INDEX IF NOT EXISTS idx_assignments_gift ON assignments(giftId);
      `
      );
      await ensureColumn(db, "gifts", "active", "INTEGER NOT NULL DEFAULT 1");
      await ensureColumn(db, "gifts", "stock", "INTEGER NOT NULL DEFAULT 1");
      await ensureColumn(db, "assignments", "name", "TEXT");
      await ensureColumn(db, "assignments", "telegram", "TEXT");
    })();
  }
  return schemaReadyPromise;
}

async function ensureColumn(db, table, column, definition) {
  try {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    const has = (results || []).some((row) => row.name === column);
    if (!has) {
      await execSql(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  } catch (e) {
    console.warn("ensureColumn error", table, column, e?.message || e);
  }
}

function getDatabase(env) {
  if (env?.DB && typeof env.DB.prepare === "function") return env.DB;
  if (env?.__D1_BETA__) {
    const beta = env.__D1_BETA__;
    if (beta?.DB && typeof beta.DB.prepare === "function") return beta.DB;
    for (const value of Object.values(beta)) {
      if (value && typeof value.prepare === "function") return value;
    }
    if (typeof beta[Symbol.iterator] === "function") {
      for (const value of beta) {
        if (value && typeof value.prepare === "function") return value;
      }
    }
  }
  for (const value of Object.values(env || {})) {
    if (value && typeof value.prepare === "function") return value;
  }
  throw new Error("D1 binding missing");
}

async function getIpHash(request, salt) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "0.0.0.0";
  const msg = new TextEncoder().encode(ip + (salt || ""));
  const digest = await crypto.subtle.digest("SHA-256", msg);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function tryLock(env, key, ttlSeconds) {
  if (!env.KV) throw new Error("KV binding missing");
  const exists = await env.KV.get(key);
  if (exists) return false;
  await env.KV.put(key, "1", { expirationTtl: ttlSeconds || 60 });
  return true;
}

async function unlock(env, key) {
  try {
    await env.KV.delete(key);
  } catch {}
}

async function getAssignmentByHash(db, ipHash) {
  return db.prepare("SELECT id, name, telegram, giftId FROM assignments WHERE ipHash = ? ORDER BY id DESC LIMIT 1").bind(ipHash).first();
}

function sanitizeName(name) {
  const trimmed = (name || "").trim();
  if (trimmed.length < 2) throw httpError(400, "name_required");
  return trimmed.slice(0, 120);
}

function sanitizeTelegram(value) {
  const text = (value || "").trim().replace(/^@/, "");
  if (!/^[a-zA-Z0-9_]{3,}$/.test(text)) {
    throw httpError(400, "invalid_telegram");
  }
  return "@" + text;
}

function normalizeGiftPayload(data = {}) {
  const title = (data.title || "").trim();
  if (!title) throw httpError(400, "title_required");
  const description = (data.description || "").trim();
  const imageUrl = (data.imageUrl || "").trim();
  const active = data.active ? 1 : 0;
  const stockRaw = Number(data.stock ?? 1);
  const stock = Number.isFinite(stockRaw) && stockRaw >= 0 ? Math.floor(stockRaw) : 0;
  return { title, description, imageUrl, active, stock };
}

async function logAction(db, ipHash, action) {
  try {
    await db.prepare("INSERT INTO logs(ipHash, action) VALUES(?, ?)").bind(ipHash, action).run();
  } catch (e) {
    console.warn("logAction failed", e?.message || e);
  }
}

async function begin(db) {
  await execSql(db, "BEGIN IMMEDIATE");
}
async function commit(db) {
  await execSql(db, "COMMIT");
}
async function rollback(db) {
  try {
    await execSql(db, "ROLLBACK");
  } catch {}
}

async function execSql(db, sql) {
  if (typeof db.exec === "function") {
    await db.exec(sql);
  } else {
    // D1 without exec() does not support multi-statement prepare; split manually
    const parts = sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of parts) {
      await db.prepare(stmt).run();
    }
  }
}

async function run(db, sql, binds = []) {
  const stmt = db.prepare(sql);
  return (binds.length ? stmt.bind(...binds) : stmt).run();
}

function httpError(status, message) {
  const err = new Error(message || "error");
  err.status = status;
  return err;
}

async function requireAdmin(request, secret) {
  if (!secret) throw new Error("JWT_SECRET not configured");
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) throw httpError(401, "unauthorized");
  return verifyJwt(token, secret);
}

async function createJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = await signHmac(data, secret);
  return `${data}.${signature}`;
}

async function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) throw httpError(401, "invalid_token");
  const [h, p, sig] = parts;
  const data = `${h}.${p}`;
  const expected = await signHmac(data, secret);
  if (!timingSafeEqual(sig, expected)) throw httpError(401, "invalid_token");
  let payload;
  try {
    payload = JSON.parse(fromBase64url(p));
  } catch {
    throw httpError(401, "invalid_token");
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw httpError(401, "token_expired");
  return payload;
}

async function signHmac(data, secret) {
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bufferToBase64url(signature);
}

async function getHmacKey(secret) {
  if (!jwtKeyCache.has(secret)) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    jwtKeyCache.set(secret, key);
  }
  return jwtKeyCache.get(secret);
}

function base64url(input) {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(b64url) {
  const pad = 4 - (b64url.length % 4 || 4);
  const str = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad % 4);
  const decoded = atob(str);
  let result = "";
  for (let i = 0; i < decoded.length; i++) {
    result += decoded.charAt(i);
  }
  const bytes = Uint8Array.from(result, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function cryptoRandomString() {
  const arr = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
