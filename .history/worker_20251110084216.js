export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    // 🔸 обробник /img — ПЕРШИМ
    if (url.pathname.startsWith('/img/')) {
      const key = url.pathname.replace(/^\/img\//, '');
      const obj = await env.R2.get(key);
      if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders });
      const ct = obj.httpMetadata?.contentType || 'application/octet-stream';
      return new Response(obj.body, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': ct, 'Cache-Control': 'public, max-age=31536000, immutable' }
      });
    }


    // CORS
    corsHeaders = makeCORSHeaders(origin, env);
    if (isPreflight) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (url.pathname === '/api/agree' && request.method === 'POST') {
        const { name } = await readJson(request);
        const ipHash = await getIpHash(request, env.SALT);
        await env.DB.prepare("INSERT INTO logs(ipHash, action) VALUES(?, 'agree')").bind(ipHash).run();
        // Запишемо ім'я, якщо ще немає assignment
        const row = await env.DB.prepare("SELECT id FROM assignments WHERE ipHash = ?").bind(ipHash).first();
        if (!row) {
          await env.DB.prepare("INSERT INTO assignments(ipHash, name, giftId) VALUES(?, ?, NULL)").bind(ipHash, name || '').run();
        } else if (name) {
          await env.DB.prepare("UPDATE assignments SET name = ? WHERE ipHash = ?").bind(name, ipHash).run();
        }
        return json({ ok: true }, corsHeaders);
      }

      if (url.pathname === '/api/me' && request.method === 'GET') {
        const ipHash = await getIpHash(request, env.SALT);
        const row = await env.DB.prepare("SELECT a.name, a.telegram, a.giftId, g.title, g.description, g.imageUrl FROM assignments a LEFT JOIN gifts g ON a.giftId = g.id WHERE a.ipHash = ?").bind(ipHash).first();
        if (row?.giftId) {
          return json({ assigned: true, name: row.name, telegram: row.telegram, gift: { id: row.giftId, title: row.title, description: row.description, imageUrl: row.imageUrl } }, corsHeaders);
        }
        return json({ assigned: false }, corsHeaders);
      }

      if (url.pathname === '/api/random' && request.method === 'GET') {
        const ipHash = await getIpHash(request, env.SALT);
        // Якщо вже є призначення — повертаємо його
        let row = await env.DB.prepare("SELECT a.name, a.telegram, a.giftId FROM assignments a WHERE a.ipHash = ?").bind(ipHash).first();
        if (row?.giftId) {
          const gift = await env.DB.prepare("SELECT id,title,description,imageUrl FROM gifts WHERE id = ?").bind(row.giftId).first();
          return json({ already: true, gift }, corsHeaders);
        }
        // Лок на IP, щоб уникнути дублю
        const lockKey = `lock:${ipHash}`;
        const gotLock = await tryLock(env, lockKey, 10);
        if (!gotLock) return json({ error: 'busy' }, corsHeaders, 429);
        try {
          // Перезчитати assignment (раптом інший запит встиг)
          row = await env.DB.prepare("SELECT id, giftId, name FROM assignments WHERE ipHash = ?").bind(ipHash).first();
          if (row?.giftId) {
            const gift = await env.DB.prepare("SELECT id,title,description,imageUrl FROM gifts WHERE id = ?").bind(row.giftId).first();
            return json({ already: true, gift }, corsHeaders);
          }
          // Обрати випадковий активний подарунок
          const gifts = await env.DB.prepare("SELECT id,title,description,imageUrl FROM gifts WHERE active = 1").all();
          if (!gifts?.results?.length) return json({ error: 'no_active_gifts' }, corsHeaders, 400);
          const pick = gifts.results[Math.floor(Math.random() * gifts.results.length)];
          await env.DB.prepare("UPDATE assignments SET giftId = ? WHERE ipHash = ?").bind(pick.id, ipHash).run();
          await env.DB.prepare("INSERT INTO logs(ipHash, action) VALUES(?, 'random')").bind(ipHash).run();
          return json({ gift: pick }, corsHeaders);
        } finally {
          await unlock(env, lockKey);
        }
      }

      if (url.pathname === '/api/finalize' && request.method === 'POST') {
        const ipHash = await getIpHash(request, env.SALT);
        const { telegram } = await readJson(request);
        await env.DB.prepare("UPDATE assignments SET telegram = ? WHERE ipHash = ?").bind(telegram || '', ipHash).run();
        await env.DB.prepare("INSERT INTO logs(ipHash, action) VALUES(?, 'finalize')").bind(ipHash).run();
        return json({ ok: true }, corsHeaders);
      }

      // --- Admin ---
      if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        const { username, password } = await readJson(request);
        if (username === env.ADMIN_USER && password === env.ADMIN_PASS) {
          const token = await signJWT({ sub: 'admin', iat: Math.floor(Date.now()/1000) }, env.JWT_SECRET, 3600*12);
          return json({ token }, corsHeaders);
        }
        return json({ error: 'unauthorized' }, corsHeaders, 401);
      }

      // Авторизація
      if (url.pathname.startsWith('/api/admin/')) {
        const auth = request.headers.get('Authorization')||'';
        const ok = await verifyBearer(auth, env.JWT_SECRET);
        if (!ok) return json({ error: 'unauthorized' }, corsHeaders, 401);
      }

      if (url.pathname === '/api/admin/gifts') {
        if (request.method === 'GET') {
          const id = url.searchParams.get('id');
          if (id) {
            const one = await env.DB.prepare("SELECT * FROM gifts WHERE id = ?").bind(id).first();
            return json({ item: one }, corsHeaders);
          }
          const list = await env.DB.prepare("SELECT * FROM gifts ORDER BY id DESC").all();
          return json({ items: list.results||[] }, corsHeaders);
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          const { title, description, imageUrl, active } = body;
          await env.DB.prepare("INSERT INTO gifts(title,description,imageUrl,active) VALUES(?,?,?,?)").bind(title, description||'', imageUrl||'', active?1:0).run();
          return json({ ok: true }, corsHeaders);
        }
        if (request.method === 'PUT') {
          const id = url.searchParams.get('id');
          const body = await readJson(request);
          const { title, description, imageUrl, active } = body;
          await env.DB.prepare("UPDATE gifts SET title=?, description=?, imageUrl=?, active=? WHERE id = ?").bind(title, description||'', imageUrl||'', active?1:0, id).run();
          return json({ ok: true }, corsHeaders);
        }
        if (request.method === 'DELETE') {
          const id = url.searchParams.get('id');
          await env.DB.prepare("DELETE FROM gifts WHERE id = ?").bind(id).run();
          return json({ ok: true }, corsHeaders);
        }
      }

      if (url.pathname === '/api/admin/assignments') {
        if (request.method === 'GET') {
          const q = url.searchParams.get('q');
          let sql = "SELECT id, name, telegram, giftId, createdAt FROM assignments ORDER BY id DESC";
          let stmt = env.DB.prepare(sql);
          if (q) {
            sql = "SELECT id, name, telegram, giftId, createdAt FROM assignments WHERE name LIKE ? OR telegram LIKE ? ORDER BY id DESC";
            stmt = env.DB.prepare(sql).bind(`%${q}%`,`%${q}%`);
          }
          const list = await stmt.all();
          return json({ items: list.results||[] }, corsHeaders);
        }
        if (request.method === 'DELETE') {
          const id = url.searchParams.get('id');
          await env.DB.prepare("DELETE FROM assignments WHERE id = ?").bind(id).run();
          return json({ ok: true }, corsHeaders);
        }
      }

      return json({ error: 'not_found' }, corsHeaders, 404);
    } catch (e) {
      return json({ error: String(e?.message||e) }, makeCORSHeaders(origin, env), 500);
    }
  }
}

// ===== Helpers =====
function makeCORSHeaders(origin, env){
  const allow = env.ALLOWED_ORIGIN || '';
  const ok = allow && origin === allow;
  const headers = {
    'Access-Control-Allow-Origin': ok ? allow : '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400'
  };
  return headers;
}

function json(data, headers={}, status=200){
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function readJson(request){ return await request.json(); }

async function getIpHash(request, salt){
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '0.0.0.0';
  const msg = new TextEncoder().encode(ip + (salt||''));
  const digest = await crypto.subtle.digest('SHA-256', msg);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function tryLock(env, key, ttlSeconds){
  const exists = await env.KV.get(key);
  if (exists) return false;
  await env.KV.put(key, '1', { expirationTtl: ttlSeconds||10 });
  return true;
}
async function unlock(env, key){
  await env.KV.delete(key);
}

// ---- JWT HS256 ----
async function signJWT(payload, secret, ttlSec){
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now()/1000);
  const exp = iat + (ttlSec||3600);
  const full = { ...payload, iat, exp };
  const enc = (obj)=>b64url(JSON.stringify(obj));
  const data = enc(header)+'.'+enc(full);
  const sig = await hmacSha256(data, secret);
  return data+'.'+sig;
}
async function verifyBearer(authHeader, secret){
  const m = /^Bearer\s+(.+)$/.exec(authHeader||'');
  if(!m) return false;
  return await verifyJWT(m[1], secret);
}
async function verifyJWT(token, secret){
  const parts = token.split('.');
  if(parts.length!==3) return false;
  const [h,p,sig] = parts;
  const data = h+'.'+p;
  const expSig = await hmacSha256(data, secret);
  if (safeEq(sig, expSig) !== true) return false;
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  if (payload.exp && Math.floor(Date.now()/1000) > payload.exp) return false;
  return true;
}
function b64url(str){ return btoa(unescape(encodeURIComponent(str))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function b64urlDecode(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); const pad = s.length%4? 4-(s.length%4):0; return Uint8Array.from(atob(s+"=".repeat(pad)), c=>c.charCodeAt(0)); }
async function hmacSha256(data, secret){
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function safeEq(a,b){ if(a.length!==b.length) return false; let r=0; for(let i=0;i<a.length;i++) r|=a.charCodeAt(i)^b.charCodeAt(i); return r===0; }