const API = () => window.API_BASE?.replace(/\/$/, '') || '';
const $   = (s, root = document) => root.querySelector(s);
const $$  = (s, root = document) => Array.from(root.querySelectorAll(s));

let token = localStorage.getItem('admToken') || '';

function setAuthHeader(h = {}) {
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

/* ===================== AUTH HELPER ===================== */
function safeJson(txt) { try { return JSON.parse(txt); } catch { return {}; } }

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
    const t = await res.text().catch(()=> '');
    const msg = t && t[0] === '{' ? (safeJson(t).error || 'unauthorized') : 'unauthorized';
    $('#loginMsg').textContent = 'Сесія завершена. Увійдіть знову. (' + msg + ')';
    throw new Error('Unauthorized');
  }

  return res;
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

      if (btn.dataset.tab === 'gifts')        await loadGifts();
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

  tbody.innerHTML = '<tr><td colspan="5">Завантаження…</td></tr>';

  try {
    const r = await fetchAuth(base + '/api/admin/gifts');
    const t = await r.text();
    const j = safeJson(t);
    const items = j.items || [];

    tbody.innerHTML = '';

    items.forEach(g => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${g.id}</td>
        <td>${escapeHtml(g.title)}</td>
        <td>${g.stock ?? 0}</td>
        <td>${g.active ? '<span class="status ok">✅ Активний</span>' : '<span class="status no">⛔ Вимкнено</span>'}</td>
        <td>
          <div class="td-actions">
            <button class="btn btn-ghost" data-act="edit" data-id="${g.id}">Редагувати</button>
            <button class="btn btn-ghost btn-danger" data-act="del"  data-id="${g.id}">Видалити</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="5">Поки порожньо</td></tr>';
    }

    // делегований обробник
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
    tbody.innerHTML = '<tr><td colspan="5">Помилка завантаження</td></tr>';
  }
}

function openGiftForm(item) {
  editGiftId = item?.id || null;
  $('#giftFormTitle').textContent = editGiftId ? 'Редагувати подарунок' : 'Новий подарунок';
  $('#giftTitle').value = item?.title || '';
  $('#giftDesc').value  = item?.description || '';
  $('#giftImg').value   = item?.imageUrl || '';
  $('#giftStock').value = item?.stock ?? 1;
  $('#giftActive').checked = item ? !!item.active : true;
  $('#giftFormWrap').style.display = 'block';
  refreshPreview();
}

async function saveGift() {
  const base = API();
  const payload = {
    title: ($('#giftTitle')?.value || '').trim(),
    description: ($('#giftDesc')?.value || '').trim(),
    imageUrl: ($('#giftImg')?.value || '').trim(),
    stock: Math.max(0, parseInt($('#giftStock')?.value || '1', 10) || 0),
    active: $('#giftActive')?.checked ? 1 : 0
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
    $('#giftFormWrap').style.display = 'none';
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
          <div class="td-actions">
            <button class="btn btn-ghost btn-danger" data-id="${a.id}">Видалити</button>
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
    btn.textContent = 'Завантажити фото';
  }
});

/* ===================== HELPERS ===================== */
function escapeHtml(str = '') {
  return str.replace(/[&<>"]+/g, s => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[s]));
}

/* ===================== INIT ===================== */
(function initAdmin() {
  console.log('API_BASE =', API());
  bindTabs();

  // якщо токен вже є — пробуємо одразу
  if (token) {
    $('#loginView')?.classList.add('hidden');
    $('#adminView')?.classList.remove('hidden');
    loadGifts(); // fetchAuth на 401 сам поверне на логін
  }
})();
