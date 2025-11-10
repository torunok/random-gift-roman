const API = () => window.API_BASE?.replace(/\/$/, '') || '';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));


let token = localStorage.getItem('admToken') || '';
function setAuthHeader(h = {}) { if (token) h['Authorization'] = 'Bearer ' + token; return h; }


// ===== Tabs =====
$$('.tab').forEach(btn => btn.addEventListener('click', () => {
$$('.tab').forEach(b => b.classList.remove('active'));
btn.classList.add('active');
$$('.tabpane').forEach(p => p.classList.remove('active'));
$('#tab-' + btn.dataset.tab).classList.add('active');
}));


// ===== Login =====
$('#btnLogin')?.addEventListener('click', async () => {
const username = $('#admUser').value.trim();
const password = $('#admPass').value.trim();
const r = await fetch(API() + "/api/admin/login", {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ username, password })
});
if (r.ok) {
const j = await r.json();
token = j.token;
localStorage.setItem('admToken', token);
$('#loginView').classList.add('hidden');
$('#adminView').classList.remove('hidden');
loadGifts();
loadAssigns();
} else {
$('#loginMsg').textContent = 'Невірні дані';
}
});


// ===== Gifts CRUD =====
$('#btnReloadGifts')?.addEventListener('click', loadGifts);
$('#btnNewGift')?.addEventListener('click', () => openGiftForm());
$('#btnCancelGift')?.addEventListener('click', () => { $('#giftFormWrap').style.display = 'none'; });
$('#btnSaveGift')?.addEventListener('click', saveGift);


let editGiftId = null;


async function loadGifts() {
const r = await fetch(API() + "/api/admin/gifts", { headers: setAuthHeader() });
const j = await r.json();
const tbody = $('#giftsTable tbody');
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
<button class="btn btn-ghost" data-act="del" data-id="${g.id}">Видалити</button>
</div>
</td>`;
tbody.appendChild(tr);
});


tbody.onclick = async (e) => {
const b = e.target.closest('button'); if (!b) return;
const id = Number(b.dataset.id);
if (b.dataset.act === 'edit') {
const one = await fetch(API() + `/api/admin/gifts?id=${id}`, { headers: setAuthHeader() }).then(r => r.json());
openGiftForm(one.item);
} else if (b.dataset.act === 'del') {
if (confirm('Видалити подарунок?')) {
await fetch(API() + `/api/admin/gifts?id=${id}`, { method: 'DELETE', headers: setAuthHeader() });
loadGifts();
}
}
};
}


function openGiftForm(item) {
editGiftId = item?.id || null;
$('#giftFormTitle').textContent = editGiftId ? 'Редагувати подарунок' : 'Новий подарунок';
$('#giftTitle').value = item?.title || '';
$('#giftDesc').value = item?.description || '';
$('#giftImg').value = item?.imageUrl || '';
$('#giftActive').checked = item ? !!item.active : true;
$('#giftFormWrap').style.display = 'block';
refreshPreview();
}


async function saveGift() {
const payload = {
title: $('#giftTitle').value.trim(),
description: $('#giftDesc').value.trim(),
imageUrl: $('#giftImg').value.trim(),
active: $('#giftActive').checked ? 1 : 0
};
if (!payload.title) { alert('Назва обов’язкова'); return; }
if (editGiftId) {
await fetch(API() + `/api/admin/gifts?id=${editGiftId}`, {
method: 'PUT',
headers: setAuthHeader({ 'Content-Type': 'application/json' }),
body: JSON.stringify(payload)
});
} else {
await fetch(API() + `/api/admin/gifts`, {
method: 'POST',
headers: setAuthHeader({ 'Content-Type': 'application/json' }),
body: JSON.stringify(payload)
});