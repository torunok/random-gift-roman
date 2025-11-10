export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const isPreflight = request.method === 'OPTIONS';
    const corsHeaders = makeCORSHeaders(origin, env);

    // ===== R2: статичні зображення (/img/...) =====
    if (url.pathname.startsWith('/img/')) {
      try {
        const key = url.pathname.replace(/^\/img\//, '');
        const obj = await env.R2.get(key);
        if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders });
        const ct = obj.httpMetadata?.contentType || guessContentTypeByKey(key) || 'application/octet-stream';
        return new Response(obj.body, {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': ct,
            'Cache-Control': 'public, max-age=31536000, immutable'
          }
        });
      } catch (e) {
        return new Response('R2 error: ' + (e?.message || e), { status: 500, headers: corsHeaders });
      }
    }

    if (isPreflight) return new Response(null, { status: 204, headers: corsHeaders });

    try {
      // ===== ПУБЛІЧНІ API =====

      // Згода
      if (url.pathname === '/api/agree' && request.method === 'POST') {
        const { name } = await readJson(request);
        const ipHash = await getIpHash(request, env.SALT);
        await env.DB.prepare("INSERT INTO logs(ipHash, action) VALUES(?, 'agree')").bind(ipHash).run();

        const row = await env.DB.prepare("SELECT id FROM assignments WHERE ipHash = ?").bind(ipHash).first();
        if (!row) {
          await env.DB.prepare("INSERT INTO assignments(ipHash, name, giftId) VALUES(?, ?, NULL)")
            .bind(ipHash, sanitizeStr(name)).run();
        } else if (name) {
          await env.DB.prepare("UPDATE assignments SET name = ? WHERE ipHash = ?")
            .bind(sanitizeStr(name), ipHash).run();
        }
        return json({ ok: true }, corsHeaders);
      }

      // Мій статус
      if (url.pathname === '/api/me' && request.method === 'GET') {
        const ipHash = await getIpHash(request, env.SALT);
        const row = await env.DB.prepare(
          "SELECT a.name, a.telegram, a.giftId, g.title, g.description, g.imageUrl " +
          "FROM assignments a LEFT JOIN gifts g ON a.giftId = g.id WHERE a.ipHash = ?"
        ).bind(ipHash).first();

        if (row?.giftId) {
          return json({
            assigned: true,
            name: row.name,
            telegram: row.telegram,
            gift: { id: row.giftId, title: row.title, description: row.description, imageUrl: row.imageUrl }
          }, corsHeaders);
        }
        return json({ assigned: false }, corsHeaders);
      }

      // Рандом з УНІКАЛЬНІСТЮ: транзакція + stock
      if (url.pathname === '/api/random' && request.method === 'GET') {
        const ipHash = await getIpHash(request, env.SALT);

        // якщо вже є призначення — повертаємо його (не витрачаємо stock вдруге)
        const existing = await env.DB
          .prepare("SELECT giftId FROM assignments WHERE ipHash = ?")
          .bind(ipHash)
          .first();

        if (existing?.giftId) {
          const gift = await env.DB.prepare(
            "SELECT id, title, description, imageUrl FROM gifts WHERE id = ?"
          ).bind(existing.giftId).first();
          return json({ already: true, gift }, corsHeaders);
        }

        // глобальний KV-лок на короткий час, щоб мінімізувати гонки між різними IP
        const lockKey = `lock:random`;
        const gotLock = await tryLock(env, lockKey, 90);
        if (!gotLock) return json({ error: 'busy' }, corsHeaders, 429);

        try {
          // ще раз перечитуємо стан assignments для цього IP (на випадок паралельного agree)
          const recheck = await env.DB
            .prepare("SELECT giftId FROM assignments WHERE ipHash = ?")
            .bind(ipHash)
            .first();

          if (recheck?.giftId) {
            const gift = await env.DB.prepare(
              "SELECT id, title, description, imageUrl FROM gifts WHERE id = ?"
            ).bind(recheck.giftId).first();
            return json({ already: true, gift }, corsHeaders);
          }

          // ТРАНЗАКЦІЯ: беремо випадковий активний подарунок зі stock>0, декрементимо, присвоюємо
          // (BEGIN IMMEDIATE блокує інші записи до COMMIT)
          await env.DB.exec("BEGIN IMMEDIATE");

          // 1) випадковий подарунок із stock>0
          const pick = await env.DB.prepare(
            "SELECT id, title, description, imageUrl FROM gifts " +
            "WHERE active = 1 AND stock > 0 " +
            "ORDER BY RANDOM() LIMIT 1"
          ).first();

          if (!pick) {
            await env.DB.exec("ROLLBACK");
            return json({ error: 'no_stock' }, corsHeaders, 409); // закінчилися доступні подарунки
          }

          // 2) декремент stock (атомарно у транзакції)
          const dec = await env.DB.prepare(
            "UPDATE gifts SET stock = stock - 1 WHERE id = ? AND stock > 0"
          ).bind(pick.id).run();

          if (!dec.success) {
            await env.DB.exec("ROLLBACK");
            return json({ error: 'race_lost' }, corsHeaders, 409);
          }

          // 3) створити рядок assignments, якщо не існує
          const existsAssign = await env.DB.prepare(
            "SELECT id FROM assignments WHERE ipHash = ?"
          ).bind(ipHash).first();

          if (!existsAssign) {
            await env.DB.prepare(
              "INSERT INTO assignments(ipHash, giftId) VALUES(?, ?)"
            ).bind(ipHash, pick.id).run();
          } else {
            await env.DB.prepare(
              "UPDATE assignments SET giftId = ? WHERE ipHash = ?"
            ).bind(pick.id, ipHash).run();
          }

          await env.DB.prepare("INSERT INTO logs(ipHash, action) VALUES(?, 'random')").bind(ipHash).run();
          await env.DB.exec("COMMIT");

          return json({ gift: pick }, corsHeaders);
        } catch (e) {
          try { await env.DB.exec("ROLLBACK"); } catch {}
          return json({ error: String(e?.message || e) }, corsHeaders, 500);
        } finally {
          await unlock(env, lockKey);
        }
      }

      // Фіналізація: записати Telegram (поле обов’язкове — перевіримо на бекенді)
      if (url.pathname === '/api/finalize' && request.method === 'POST') {
        const ipHash = await getIpHash(request, env.SALT);
        const { telegram } = await readJson(request);
        const tg = (telegram || '').trim();
        if (!tg) return json({ error: 'telegram_required' }, corsHeaders, 400);

        await env.DB.prepare("UPDATE assignments SET telegram = ? WHERE ipHash = ?")
          .bind(sanitizeStr(tg), ipHash).run();
        await env.DB.prepare("INSERT INTO logs(ipHash, action) VALUES(?, 'finalize')").bind(ipHash).run();
        return json({ ok: true }, corsHeaders);
      }

      // ===== АДМІН =====

      // Логін
      if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        const body = await readJson(request);
        const username = String(body?.username || '').trim();
        const password = String(body?.password || '').trim();

        const uOk = username.toLowerCase() === String(env.ADMIN_USER || '').trim().toLowerCase();
        const pOk = password === String(env.ADMIN_PASS || '').trim();

        if (uOk && pOk) {
          const token = await signJWT({ sub: 'admin' }, env.JWT_SECRET, 3600 * 12);
          return json({ token }, corsHeaders);
        }
        await env.DB.prepare("INSERT INTO logs(ipHash, action) VALUES(?, 'admin_login_fail')")
          .bind(await getIpHash(request, env.SALT)).run();
        return json({ error: 'unauthorized' }, corsHeaders, 401);
      }

      // Авторизація для /api/admin/*
      if (url.pathname.startsWith('/api/admin/')) {
        const auth = request.headers.get('Authorization') || '';
        const ok = await verifyBearer(auth, env.JWT_SECRET);
        if (!ok) return json({ error: 'unauthorized' }, corsHeaders, 401);
      }

      // Gifts CRUD (із stock)
      if (url.pathname === '/api/admin/gifts') {
        if (request.method === 'GET') {
          const id = url.searchParams.get('id');
          if (id) {
            const one = await env.DB.prepare("SELECT * FROM gifts WHERE id = ?").bind(id).first();
            return json({ item: one }, corsHeaders);
          }
          const list = await env.DB.prepare("SELECT * FROM gifts ORDER BY id DESC").all();
          return json({ items: list.results || [] }, corsHeaders);
        }

        if (request.method === 'POST') {
          const body = await readJson(request);
          const { title, description, imageUrl, active, stock } = body || {};
          const st = clampInt(stock, 0, 1_000_000);
          await env.DB.prepare(
            "INSERT INTO gifts(title,description,imageUrl,active,stock) VALUES(?,?,?,?,?)"
          ).bind(
            sanitizeStr(title),
            sanitizeStr(description),
            sanitizeStr(imageUrl),
            active ? 1 : 0,
            st ?? 1
          ).run();
          return json({ ok: true }, corsHeaders);
        }

        if (request.method === 'PUT') {
          const id = url.searchParams.get('id');
          const body = await readJson(request);
          const { title, description, imageUrl, active, stock } = body || {};
          const st = clampInt(stock, 0, 1_000_000);
          await env.DB.prepare(
            "UPDATE gifts SET title=?, description=?, imageUrl=?, active=?, stock=? WHERE id = ?"
          ).bind(
            sanitizeStr(title),
            sanitizeStr(description),
            sanitizeStr(imageUrl),
            active ? 1 : 0,
            st ?? 1,
            id
          ).run();
          return json({ ok: true }, corsHeaders);
        }

        if (request.method === 'DELETE') {
          const id = url.searchParams.get('id');
          // опційно: видалити картинку з R2, якщо локальна
          const g = await env.DB.prepare("SELECT imageUrl FROM gifts WHERE id = ?").bind(id).first();
          if (g?.imageUrl && g.imageUrl.startsWith('/img/')) {
            const key = g.imageUrl.replace(/^\/img\//, '');
            await env.R2.delete(key).catch(() => {});
          }
          await env.DB.prepare("DELETE FROM gifts WHERE id = ?").bind(id).run();
          return json({ ok: true }, corsHeaders);
        }
      }

      // Admin Assignments
      if (url.pathname === '/api/admin/assignments') {
        if (request.method === 'GET') {
          const q = url.searchParams.get('q')?.trim();
          let sql = "SELECT id, ipHash, name, telegram, giftId, createdAt FROM assignments";
          let params = [];
          if (q) {
            sql += " WHERE (name LIKE ? OR telegram LIKE ?)";
            const like = `%${q}%`;
            params = [like, like];
          }
          sql += " ORDER BY id DESC LIMIT 500";
          const list = await env.DB.prepare(sql).bind(...params).all();
          return json({ items: list.results || [] }, corsHeaders);
        }

        if (request.method === 'DELETE') {
          const id = url.searchParams.get('id');
          if (!id) return json({ error: 'id_required' }, corsHeaders, 400);
          await env.DB.prepare("DELETE FROM assignments WHERE id = ?").bind(id).run();
          return json({ ok: true }, corsHeaders);
        }
      }

      // Admin Upload → R2
      if (url.pathname === '/api/admin/upload' && request.method === 'POST') {
        const ctype = request.headers.get('Content-Type') || '';
        if (!ctype.includes('multipart/form-data')) {
          return json({ error: 'content_type' }, corsHeaders, 400);
        }
        const form = await request.formData();
        const file = form.get('file');
        if (!file || typeof file === 'string') return json({ error: 'no_file' }, corsHeaders, 400);

        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        const maxBytes = 10 * 1024 * 1024;
        const fileType = file.type || 'application/octet-stream';
        const fileSize = typeof file.size === 'number' ? file.size : undefined;
        if (!allowed.includes(fileType)) return json({ error: 'bad_type' }, corsHeaders, 415);
        if (fileSize != null && fileSize > maxBytes) return json({ error: 'too_large' }, corsHeaders, 413);

        const ext = file.name?.split('.').pop()?.toLowerCase() || mimeExt(fileType) || 'jpg';
        const key = `gifts/${cryptoRandomHex(16)}.${ext}`;

        await env.R2.put(key, file.stream(), { httpMetadata: { contentType: fileType } });

        return json({ url: `/img/${key}`, key }, corsHeaders);
      }

      return json({ error: 'not_found' }, corsHeaders, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, corsHeaders, 500);
    }
  }
};

/* ===== Helpers ===== */
function makeCORSHeaders(origin, env) {
  const allow = env.ALLOWED_ORIGIN || '';
  const ok = allow && origin === allow;
  return {
    'Access-Control-Allow-Origin': ok ? allow : '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400'
  };
}
function json(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function sanitizeStr(s) { return s == null ? '' : String(s).slice(0, 2000); }
function clampInt(n, min, max) { n = Number.isFinite(+n) ? +n : null; if (n == null) return null; return Math.max(min, Math.min(max, Math.trunc(n))); }
async function readJson(request) { const t = await request.text(); if (!t) return {}; try { return JSON.parse(t); } catch { return {}; } }
async function getIpHash(request, salt) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '0.0.0.0';
  const msg = new TextEncoder().encode(ip + (salt || ''));
  const digest = await crypto.subtle.digest('SHA-256', msg);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}
async function tryLock(env, key, ttlSeconds){
  const ttl = Math.max(Number(ttlSeconds)||0, 60);
  const exists = await env.KV.get(key);
  if (exists) return false;
  await env.KV.put(key, '1', { expirationTtl: ttl });
  return true;
}
async function unlock(env, key){ await env.KV.delete(key); }

/* ===== JWT HS256 ===== */
async function signJWT(payload, secret, ttlSec) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (ttlSec || 3600);
  const full = { ...payload, iat, exp };
  const enc = (obj) => b64url(JSON.stringify(obj));
  const data = enc(header) + '.' + enc(full);
  const sig = await hmacSha256(data, secret);
  return data + '.' + sig;
}
async function verifyBearer(authHeader, secret) {
  const m = /^Bearer\s+(.+)$/.exec(authHeader || '');
  if (!m) return false;
  return await verifyJWT(m[1], secret);
}
async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts;
  const data = h + '.' + p;
  const expSig = await hmacSha256(data, secret);
  if (safeEq(sig, expSig) !== true) return false;
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return false;
  return true;
}
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  return Uint8Array.from(atob(s + '='.repeat(pad)), c => c.charCodeAt(0));
}
async function hmacSha256(data, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ===== misc ===== */
function cryptoRandomHex(nBytes) { const arr = new Uint8Array(nBytes); crypto.getRandomValues(arr); return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join(''); }
function mimeExt(type) { if (type === 'image/jpeg') return 'jpg'; if (type === 'image/png') return 'png'; if (type === 'image/webp') return 'webp'; return 'bin'; }
function guessContentTypeByKey(key) {
  const k = key.toLowerCase();
  if (k.endsWith('.jpg') || k.endsWith('.jpeg')) return 'image/jpeg';
  if (k.endsWith('.png')) return 'image/png';
  if (k.endsWith('.webp')) return 'image/webp';
  if (k.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return null;
}
