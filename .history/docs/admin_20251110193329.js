const API = () => window.API_BASE?.replace(/\/$/, '') || '';
const $   = (s, root = document) => root.querySelector(s);
const $$  = (s, root = document) => Array.from(root.querySelectorAll(s));

let token = localStorage.getItem('admToken') || '';
function setAuthHeader(h = {}) {
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

/* ===================== TABS ===================== */
$$('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.tabpane').forEach(p => p.classList.remove('active'));
    const pane = $('#tab-' + btn.dataset.tab);
    if (pane) pane.classList.add('active');
  });
});

/* ===================== LOGIN ===================== */
$('#btnLogin')?.addEventListener('click', async () => {
  const username = $('#admUser')?.value.trim() || '';
  const password = $('#admPass')?.value.trim() || '';

  const base = API();
  if (!base) {
    alert('API_BASE не задано. Додайте window.API_BASE у admin.html');
    return;
  }

  const r = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (r.ok) {
    const j = await r.json();
    token = j.token;
    localStorage.setItem('admToken', token);
    $('#loginView')?.classList.add('hidden');
    $('#adminView')?.classList.remove('hidden');
    await loadGifts();
    await loadAssigns();
  } else {
    $('#loginMsg').textContent = 'Невірні дані';
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

  let j = { items: [] };
  try {
    const r = await fetch(base + '/api/admin/gifts', { headers: setAuthHeader() });
    j = await r.json();
  } catch (e) {
    console.warn('Gifts load error:', e);
  }

  tbody.innerHTML = '';
  (j.items || []).forEach(g => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${g.id}</td>
      <td>${escapeHtml(g.title)}</td>
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

  tbody.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const id = Number(b.dataset.id);

    if (b.dataset.act === 'edit') {
      const one = await fetch(base + `/api/admin/gifts?id=${id}`, { headers: setAuthHeader() }).then(r => r.json());
      openGiftForm(one.item);
    } else if (b.dataset.act === 'del') {
      if (confirm('Видалити подарунок?')) {
        await fetch(base + `/api/admin/gifts?id=${id}`, { method: 'DELETE', headers: setAuthHeader() });
        loadGifts();
      }
    }
  };
}

function openGiftForm(item) {
  editGiftId = item?.id || null;
  const t = $('#giftFormTitle');
  if (t) t.textContent = editGiftId ? 'Редагувати подарунок' : 'Новий подарунок';
  const title = $('#giftTitle');
  const desc  = $('#giftDesc');
  const img   = $('#giftImg');
  const active= $('#giftActive');
  if (title)  title.value = item?.title || '';
  if (desc)   desc.value  = item?.description || '';
  if (img)    img.value   = item?.imageUrl || '';
  if (active) active.checked = item ? !!item.active : true;
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
    active: $('#giftActive')?.checked ? 1 : 0
  };
  if (!payload.title) { alert('Назва обов’язкова'); return; }

  if (editGiftId) {
    await fetch(base + `/api/admin/gifts?id=${editGiftId}`, {
      method: 'PUT',
      headers: setAuthHeader({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
  } else {
    await fetch(base + '/api/admin/gifts', {
      method: 'POST',
      headers: setAuthHeader({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
  }

  const wrap = $('#giftFormWrap');
  if (wrap) wrap.style.display = 'none';
  loadGifts();
}

/* ===================== PARTICIPANTS (ASSIGNMENTS) ===================== */
$('#btnReloadAssign')?.addEventListener('click', loadAssigns);
$('#searchAssign')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') loadAssigns(); });

async function loadAssigns() {
  const base = API();
  const tbody = $('#assignTable tbody');
  if (!tbody) return;

  const qEl = $('#searchAssign');
  const q = (qEl?.value || '').trim();

  const url = new URL(base + '/api/admin/assignments');
  if (q) url.searchParams.set('q', q);

  let j = { items: [] };
  try {
    const r = await fetch(url.toString(), { headers: setAuthHeader() });
    j = await r.json();
  } catch (e) {
    console.warn('Assignments load error:', e);
  }

  tbody.innerHTML = '';
  (j.items || []).forEach(a => {
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

  tbody.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (confirm('Видалити призначення?')) {
      await fetch(base + `/api/admin/assignments?id=${id}`, { method: 'DELETE', headers: setAuthHeader() });
      loadAssigns();
    }
  };
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
    const res = await apiUpload(file); // { url, key }
    if (urlInput) urlInput.value = res.url;    // /img/gifts/....webp
    const src = res.url.startsWith('http') ? res.url : (API() + res.url);
    if (preview) {
      preview.src = src;
      preview.style.display = 'block';
    }
    if (hint) hint.textContent = 'Фото завантажено ✅ URL підставлено';
  } catch (e) {
    alert('Помилка аплоаду: ' + e.message);
    if (hint) hint.textContent = 'Помилка аплоаду';
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
});

async function apiUpload(file) {
  const fd = new FormData();
  fd.append('file', file);

  const res  = await fetch(API() + '/api/admin/upload', {
    method: 'POST',
    headers: setAuthHeader(), // Authorization Bearer
    body: fd
  });
  const text = await res.text();

  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.error || text;
    } catch {}
    throw new Error(`Upload failed (${res.status}): ${msg}`);
  }

  return JSON.parse(text); // { url, key }
}

/* ===================== HELPERS ===================== */
function escapeHtml(str = '') {
  return str.replace(/[&<>"]+/g, s => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[s]));
}

/* ===================== AUTO LOGIN RESUME ===================== */
(async function initAdmin() {
  // Швидка перевірка бази
  console.log('API_BASE =', API());

  if (token) {
    $('#loginView')?.classList.add('hidden');
    $('#adminView')?.classList.remove('hidden');
    await loadGifts();
    await loadAssigns();
  }
})();
