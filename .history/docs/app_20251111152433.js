// ========== БАЗА ==========
const API = () => (window.API_BASE || '').replace(/\/$/, '');
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const stage = $('#stage');
const consentModal = $('#consentModal');
const inputName = $('#inputName');
const checkboxAgree = $('#checkboxAgree');
const btnAgree = $('#btnAgree');
const btnPass = $('#btnPass');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
function escapeHtml(str = '') { return String(str).replace(/[&<>"]+/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[s])); }

// Безпечний fetch API з лімітованим парсингом
async function api(path, opts = {}) {
  const url = API() + path;
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
  } catch (e) {
    throw new Error('Немає інтернету або сервер недоступний');
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : (text || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return data;
}

// Абсолютний URL до зображення
function absoluteUrl(u = '') {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return API() + u;
}

// ====== CONSENT ======
function showConsent() {
  consentModal?.setAttribute('aria-hidden', 'false');
  // скеровуємо фокус всередину модалки
  btnAgree?.focus();
}
function hideConsent() {
  // ВАЖЛИВО: спершу скидаємо фокус, щоби не було ARIA-попередження
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
  consentModal?.setAttribute('aria-hidden', 'true');
}

checkboxAgree?.addEventListener('change', () => {
  btnAgree.disabled = !(checkboxAgree.checked && inputName.value.trim().length >= 2);
});
inputName?.addEventListener('input', () => {
  btnAgree.disabled = !(checkboxAgree.checked && inputName.value.trim().length >= 2);
});

btnPass?.addEventListener('click', () => {
  const msg = el(`<div class="card fade-in"><h2>Дякую за щирість! Гарного дня 😄</h2></div>`);
  stage.innerHTML = ''; stage.appendChild(msg); hideConsent();
  api('/api/agree', { method: 'POST', body: JSON.stringify({ name: 'PASS' }) }).catch(() => {});
});

btnAgree?.addEventListener('click', async () => {
  const name = inputName.value.trim();
  if (!name) return;

  try {
    await api('/api/agree', { method: 'POST', body: JSON.stringify({ name }) });
  } catch (e) {
    console.warn('agree failed:', e.message);
  }

  hideConsent();

  // якщо вже є призначення — показуємо фінал або просимо Telegram, якщо він відсутній
  try {
    const me = await api('/api/me', { method: 'GET' });
    if (me && me.assigned) {
      if (me.telegram && me.telegram.trim().length >= 3) {
        return renderFinal(me.gift);
      } else {
        return showThanksForm(); // обов’язковий збір Telegram
      }
    }
  } catch {}
  renderIntro(name);
});

// ====== СЦЕНИ ======
function renderIntro(name) {
  stage.innerHTML = '';
  const block = el(`
    <div class="intro fade-in">
      <div class="photo slide-left"><img src="./images/roman.png" alt="Roman"/></div>
      <div class="text slide-right">
        <h2>Привітик, ${escapeHtml(name)}! Тут все просто!)</h2>
        <p>Буде рандом, який обере подарунок, а ти повинен його подарувати мені на день народження)
        Нагадаю, це буде <strong>28 листопада</strong></p>
        <button id="btnGo" class="btn btn-primary">Даю добро на рандом!</button>
      </div>
    </div>
  `);
  stage.appendChild(block);
  block.querySelector('#btnGo').addEventListener('click', startRandom);
}

function makeOverlay() {
  const blackout = el(`<div id="blackOverlay" class="full-black ease-slow">...</div>`);
  return blackout;
}

async function startRandom() {
  stage.innerHTML = '';
  const blackout = makeOverlay();
  stage.appendChild(blackout);

  await sleep(1200);
  blackout.textContent = 'Все ґуд, це просто такий ефект)';
  await sleep(600);
  for (let i = 5; i >= 1; i--) {
    blackout.textContent = String(i);
    await sleep(600);
  }

  let res;
  try {
    res = await api('/api/random', { method: 'GET' });
  } catch (e) {
    $('#blackOverlay')?.remove();
    alert('Помилка під час отримання подарунка: ' + e.message);
    return;
  }

  // Коректна реакція на службові помилки бекенда
  if (res && (res.error === 'no_active_gifts' || res.error === 'no_stock')) {
    $('#blackOverlay')?.remove();
    alert(
      res.error === 'no_stock'
        ? 'Немає доступних подарунків зі stock > 0. Додай/онови в адмінці.'
        : 'Немає активних подарунків. Увімкни хоча б один у адмінці.'
    );
    return;
  }

  const gift = res?.gift || (res?.already ? res.gift : null);
  if (!gift || !gift.imageUrl) {
    $('#blackOverlay')?.remove();
    alert('Подарунок не отримано. Спробуй ще раз або перевір дані в адмінці.');
    return;
  }

  $('#blackOverlay')?.remove();
  await showGiftSequence(gift);
}

async function showGiftSequence(gift) {
  stage.innerHTML = '';

  // 1) показ фото по центру
  const first = el(`
    <div class="center">
      <img class="gift-img scale-in" id="giftImgCenter" src="${escapeHtml(absoluteUrl(gift.imageUrl))}" alt="gift"/>
    </div>
  `);
  stage.appendChild(first);
  await sleep(3000);

  // 2) фото + опис + кнопка ПІД описом (22px)
  stage.innerHTML = '';
  const wrap = el(`
    <div class="gift-wrap fade-in">
      <img class="gift-img" src="${escapeHtml(absoluteUrl(gift.imageUrl))}" alt="gift"/>
      <div class="gift-desc">
        <h3>${escapeHtml(gift.title || 'Подарунок')}</h3>
        <p>${escapeHtml(gift.description || 'Опис')}</p>
        <button id="btnMore" class="btn btn-ghost" style="margin-top:22px;">Тицяй сюди!</button>
      </div>
    </div>
  `);
  stage.appendChild(wrap);

  // клік лише для цієї кнопки
  wrap.querySelector('#btnMore').addEventListener('click', showThanksForm);
}

function showThanksForm() {
  stage.innerHTML = '';
  const view = el(`
    <div class="intro fade-in ease-slow">
      <div class="photo slide-left ease-slow"><img src="./images/roman.png" alt="Roman"/></div>
      <div class="text slide-right ease-slow">
        <h2>Щиро вдячний!</h2>
        <p>Буду радий розділити цей момент з тобою. А поки запиши свій нік у Telegram, щоб я пізніше повідомив дату, місце та час).</p>
      </div>
    </div>
  `);

  const form = el(`
    <div class="card fade-in ease-slow" style="margin-top:16px;">
      <label class="field"><span>Твій Telegram-нік</span>
        <input id="tgNick" type="text" placeholder="@nickname" inputmode="text" autocomplete="username"
               required pattern="^@?[a-zA-Z0-9_]{3,}$" />
      </label>
      <div class="actions center">
        <button id="btnMeet" class="btn btn-primary" disabled>Зустрінемось</button>
      </div>
    </div>
  `);

  stage.append(view, form);

  // live-валідація
  const tgInput = form.querySelector('#tgNick');
  const meetBtn = form.querySelector('#btnMeet');
  tgInput.addEventListener('input', () => {
    const ok = /^[a-zA-Z0-9_]{3,}$/.test(tgInput.value.replace(/^@/, ''));
    meetBtn.disabled = !ok;
  });

  meetBtn.addEventListener('click', finalizeUser);
}

async function finalizeUser() {
  const inp = $('#tgNick');
  const raw = (inp?.value || '').trim();
  const nick = raw.replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{3,}$/.test(nick)) {
    alert('Вкажіть коректний нік у Telegram (мінімум 3 символи, латиниця/цифри/_)');
    return;
  }

  try {
    await api('/api/finalize', { method: 'POST', body: JSON.stringify({ telegram: '@' + nick }) });
  } catch (e) {
    alert('Не вдалося зберегти нік: ' + e.message);
    return;
  }

  try {
    const me = await api('/api/me', { method: 'GET' });
    if (me && me.assigned) return renderFinal(me.gift);
  } catch (e) {
    alert('Не вдалося отримати фінальні дані: ' + e.message);
  }
}

// ФІНАЛ БЕЗ БЛОКУ «Для: ...» — повністю прибрано
function renderFinal(gift) {
  stage.innerHTML = '';
  const block = el(`
    <div class="gift-wrap fade-in ease-slow">
      <img class="gift-img" src="${escapeHtml(absoluteUrl(gift.imageUrl || ''))}" alt="gift"/>
      <div class="gift-desc">
        <h3>${escapeHtml(gift.title || 'Подарунок')}</h3>
        <p>${escapeHtml(gift.description || 'Опис')}</p>
      </div>
    </div>
  `);
  stage.appendChild(block);
}

// ===== INIT =====
(async function init() {
  showConsent();

  try {
    const me = await api('/api/me', { method: 'GET' });
    if (me && me.assigned) {
      hideConsent();
      if (me.telegram && me.telegram.trim().length >= 3) {
        return renderFinal(me.gift);
      } else {
        return showThanksForm(); // обов’язковий збір Telegram
      }
    }
  } catch {}
})();


// ========================= ADMIN JS (нижче) =========================

const API = () => window.API_BASE?.replace(/\/$/, '') || '';
const $   = (s, root = document) => root.querySelector(s);
const $$  = (s, root = document) => Array.from(root.querySelectorAll(s));

let token = localStorage.getItem('admToken') || '';

function setAuthHeader(h = {}) {
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

/* ===================== AUTH HELPER ===================== */
async function fetchAuth(input, init = {}) {
  const url = typeof input === 'string' ? input : input.toString();
  const res = await fetch(url, {
    ...init,
    headers: setAuthHeader({ ...(init.headers || {}) })
  });

  // Авто-розлогін при 401
  if (res.status === 401) {
    console.warn('Auth 401 → reset token & show login');
    localStorage.removeItem('admToken');
    token = '';
    $('#adminView')?.classList.add('hidden');
    $('#loginView')?.classList.remove('hidden');
    // спробуємо підказку
    const t = await res.text().catch(()=> '');
    const msg = t && t[0] === '{' ? (safeJson(t).error || 'unauthorized') : 'unauthorized';
    $('#loginMsg').textContent = 'Сесія завершена. Увійдіть знову. (' + msg + ')';
    throw new Error('Unauthorized');
  }

  return res;
}

function safeJson(txt) {
  try { return JSON.parse(txt); } catch { return {}; }
}

/* ===================== TABS ===================== */
function bindTabs() {
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      $$('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.tabpane').forEach(p => p.classList.remove('active'));
      const pane = $('#tab-' + btn.dataset.tab);
      if (pane) pane.classList.add('active');

      if (btn.dataset.tab === 'gifts')       await loadGifts();
      if (btn.dataset.tab === 'participants') await loadAssigns();
    });
  });
}

/* ===================== LOGIN ===================== */
$('#btnLogin')?.addEventListener('click', async () => {
  const username = $('#admUser')?.value.trim() || '';
  const password = $('#admPass')?.value.trim() || '';
  const base = API();

  if (!base) { alert('API_BASE не задано в admin.html'); return; }

  try {
    const r = await fetch(base + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!r.ok) {
      const t = await r.text();
      const j = safeJson(t);
      $('#loginMsg').textContent = 'Невірні дані' + (j.error ? ` (${j.error})` : '');
      return;
    }

    const j = await r.json();
    token = j.token;
    localStorage.setItem('admToken', token);

    $('#loginView')?.classList.add('hidden');
    $('#adminView')?.classList.remove('hidden');

    bindTabs();
    await loadGifts(); // дефолтна активна вкладка

  } catch (e) {
    $('#loginMsg').textContent = 'Помилка з’єднання з бекендом';
    console.warn(e);
  }
});

/* ===================== GIFTS CRUD ===================== */
$('#btnReloadGifts')?.addEventListener('click', loadGifts);
$('#btnNewGift')?.addEventListener('click', () => openGiftForm());
$('#btnCancelGift')?.addEventListener('click', () => { const f = $('#giftFormWrap'); if (f) f.style.display = 'none'; });
$('#btnSaveGift')?.addEventListener('click', saveGift);

let editGiftId = null;

async function loadGifts() {
  const base = API();
  const tbody = $('#giftsTable tbody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="4">Завантаження…</td></tr>';

  try {
    const r = await fetchAuth(base + '/api/admin/gifts');
    const t = await r.text();
    const j = safeJson(t);
    const items = j.items || [];

    console.log('Gifts:', items.length);
    tbody.innerHTML = '';

    items.forEach(g => {
      const tr = document.createElement('tr');
      // Показуємо stock як бейдж у колонці з назвою (щоб не міняти заголовки таблиці)
      tr.innerHTML = `
        <td>${g.id}</td>
        <td>${escapeHtml(g.title)} ${typeof g.stock === 'number' ? `<small class="muted">· stock: ${g.stock}</small>` : ''}</td>
        <td>${g.active ? '✅' : '⛔'}</td>
        <td>
          <div class="btn-group td-actions">
            <button class="btn btn-ghost" data-act="edit" data-id="${g.id}">Редагувати</button>
            <button class="btn btn-ghost" data-act="del"  data-id="${g.id}">Видалити</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="4">Поки порожньо</td></tr>';
    }

    tbody.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const id = Number(b.dataset.id);

      if (b.dataset.act === 'edit') {
        const rr = await fetchAuth(base + `/api/admin/gifts?id=${id}`);
        const jj = await rr.json();
        openGiftForm(jj.item);
      } else if (b.dataset.act === 'del') {
        if (confirm('Видалити подарунок?')) {
          await fetchAuth(base + `/api/admin/gifts?id=${id}`, { method: 'DELETE' });
          loadGifts();
        }
      }
    };

  } catch (e) {
    console.warn('Gifts load error:', e);
    tbody.innerHTML = '<tr><td colspan="4">Помилка завантаження</td></tr>';
  }
}

function openGiftForm(item) {
  editGiftId = item?.id || null;
  const t = $('#giftFormTitle');
  if (t) t.textContent = editGiftId ? 'Редагувати подарунок' : 'Новий подарунок';
  const title = $('#giftTitle');
  const desc  = $('#giftDesc');
  const img   = $('#giftImg');
  const active= $('#giftActive');
  const stock = $('#giftStock');
  if (title)  title.value = item?.title || '';
  if (desc)   desc.value  = item?.description || '';
  if (img)    img.value   = item?.imageUrl || '';
  if (active) active.checked = item ? !!item.active : true;
  if (stock)  stock.value = String(item?.stock ?? 1);
  const wrap = $('#giftFormWrap');
  if (wrap) wrap.style.display = 'block';
  refreshPreview();
}

async function saveGift() {
  const base = API();
  const payload = {
    title: ($('#giftTitle')?.value || '').trim(),
    description: ($('#giftDesc')?.value || '').trim(),
    imageUrl: ($('#giftImg')?.value || '').trim(),
    active: $('#giftActive')?.checked ? 1 : 0,
    stock: (() => {
      const raw = Number($('#giftStock')?.value ?? '0');
      if (!Number.isFinite(raw) || raw < 0) return 0;
      return Math.floor(raw);
    })()
  };
  if (!payload.title) { alert('Назва обов’язкова'); return; }

  try {
    if (editGiftId) {
      await fetchAuth(base + `/api/admin/gifts?id=${editGiftId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      await fetchAuth(base + '/api/admin/gifts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    const wrap = $('#giftFormWrap');
    if (wrap) wrap.style.display = 'none';
    loadGifts();
  } catch (e) {
    alert('Не вдалося зберегти подарунок');
    console.warn(e);
  }
}

/* ===================== PARTICIPANTS (ASSIGNMENTS) ===================== */
$('#btnReloadAssign')?.addEventListener('click', loadAssigns);
$('#searchAssign')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') loadAssigns(); });

async function loadAssigns() {
  const base = API();
  const tbody = $('#assignTable tbody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="6">Завантаження…</td></tr>';

  try {
    const qEl = $('#searchAssign');
    const q = (qEl?.value || '').trim();

    const url = new URL(base + '/api/admin/assignments');
    if (q) url.searchParams.set('q', q);

    const r = await fetchAuth(url.toString());
    const t = await r.text();
    const j = safeJson(t);
    const items = j.items || [];

    console.log('Assignments:', items.length);
    tbody.innerHTML = '';

    items.forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${a.id}</td>
        <td>${escapeHtml(a.name || '')}</td>
        <td>${escapeHtml(a.telegram || '')}</td>
        <td>${a.giftId ?? ''}</td>
        <td>${a.createdAt ?? ''}</td>
        <td>
          <div class="btn-group td-actions">
            <button class="btn btn-ghost" data-id="${a.id}">Видалити</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6">Поки порожньо</td></tr>';
    }

    tbody.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const id = Number(b.dataset.id);
      if (confirm('Видалити призначення?')) {
        await fetchAuth(base + `/api/admin/assignments?id=${id}`, { method: 'DELETE' });
        loadAssigns();
      }
    };

  } catch (e) {
    console.warn('Assignments load error:', e);
    tbody.innerHTML = '<tr><td colspan="6">Помилка завантаження</td></tr>';
  }
}

/* ===================== UPLOAD & PREVIEW ===================== */
$('#giftImg')?.addEventListener('input', refreshPreview);

function refreshPreview() {
  const u   = ($('#giftImg')?.value || '').trim();
  const img = $('#giftPreview');
  if (!img) return;

  if (u) {
    img.src = u.startsWith('http') ? u : (API() + u);
    img.style.display = 'block';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
  }
}

$('#btnUploadImage')?.addEventListener('click', async () => {
  const fileInput = $('#giftFile');
  const urlInput  = $('#giftImg');
  const preview   = $('#giftPreview');
  const hint      = $('#uploadHint');

  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    alert('Оберіть файл зображення');
    return;
  }

  const file = fileInput.files[0];
  const btn  = $('#btnUploadImage');
  const oldText = btn.textContent;

  btn.disabled = true;
  btn.textContent = 'Завантаження...';
  if (hint) hint.textContent = 'Завантаження на сервер...';

  try {
    const res = await fetchAuth(API() + '/api/admin/upload', {
      method: 'POST',
      body: (() => { const fd = new FormData(); fd.append('file', file); return fd; })()
    });
    const txt = await res.text();
    const j = safeJson(txt);
    if (!j.url) throw new Error('bad upload response');

    if (urlInput) urlInput.value = j.url;
    const src = j.url.startsWith('http') ? j.url : (API() + j.url);
    if (preview) { preview.src = src; preview.style.display = 'block'; }
    if (hint) hint.textContent = 'Фото завантажено ✅ URL підставлено';

  } catch (e) {
    alert('Помилка аплоаду: ' + e.message);
    if (hint) hint.textContent = 'Помилка аплоаду';
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
});

/* ===================== HELPERS ===================== */
function escapeHtml(str = '') {
  return str.replace(/[&<>"]+/g, s => ({
    '&': '&amp;',
    '<': '&lt;',
    '>' : '&gt;',
    '"' : '&quot;'
  }[s]));
}

/* ===================== INIT ===================== */
(function initAdmin() {
  console.log('API_BASE =', API());
  bindTabs();

  // якщо токен вже є — пробуємо завантажити одразу
  if (token) {
    $('#loginView')?.classList.add('hidden');
    $('#adminView')?.classList.remove('hidden');
    loadGifts(); // якщо 401 — fetchAuth очистить токен і покаже форму
  }
})();
