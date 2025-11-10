const API = () => window.API_BASE?.replace(/\/$/, '') || '';
headers: setAuthHeader({ 'Content-Type': 'application/json' }),
body: JSON.stringify(payload)
});
} else {
await fetch(API() + `/api/admin/gifts`, {
method: 'POST',
headers: setAuthHeader({ 'Content-Type': 'application/json' }),
body: JSON.stringify(payload)
});
}
$('#giftFormWrap').style.display = 'none';
loadGifts();
}


// ===== Participants (assignments) =====
$('#btnReloadAssign')?.addEventListener('click', loadAssigns);
$('#searchAssign')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') loadAssigns(); });


async function loadAssigns() {
const q = $('#searchAssign').value.trim();
const url = new URL(API() + "/api/admin/assignments");
if (q) url.searchParams.set('q', q);
const r = await fetch(url.toString(), { headers: setAuthHeader() });
const j = await r.json();
const tbody = $('#assignTable tbody');
tbody.innerHTML = '';
(j.items || []).forEach(a => {
const tr = document.createElement('tr');
tr.innerHTML = `
<td>${a.id}</td>
<td>${escapeHtml(a.name || '')}</td>
<td>${escapeHtml(a.telegram || '')}</td>
<td>${a.giftId}</td>
<td>${a.createdAt}</td>
<td>
<div class="btn-group td-actions">
<button class="btn btn-ghost" data-id="${a.id}">Видалити</button>
</div>
</td>`;
tbody.appendChild(tr);
});


tbody.onclick = async (e) => {
const b = e.target.closest('button'); if (!b) return;
const id = Number(b.dataset.id);
if (confirm('Видалити призначення?')) {
await fetch(API() + `/api/admin/assignments?id=${id}`, { method: 'DELETE', headers: setAuthHeader() });
loadAssigns();
}
};
}


// ===== Upload & preview =====
$('#giftImg')?.addEventListener('input', refreshPreview);
function refreshPreview() {
const u = $('#giftImg').value.trim();
const img = $('#giftPreview');
if (!img) return;
if (u) { img.src = u.startsWith('http') ? u : (API() + u); img.style.display = 'block'; }
else { img.removeAttribute('src'); img.style.display = 'none'; }
}


$('#btnUploadImage')?.addEventListener('click', async () => {
const fileInput = $('#giftFile');
const urlInput = $('#giftImg');
const preview = $('#giftPreview');
const hint = $('#uploadHint');
if (!fileInput || !fileInput.files || !fileInput.files[0]) { alert('Оберіть файл зображення'); return; }
const file = fileInput.files[0];


const btn = $('#btnUploadImage');
const oldText = btn.textContent;
btn.disabled = true; btn.textContent = 'Завантаження...'; if (hint) hint.textContent = 'Завантаження на сервер...';


try {
const res = await apiUpload(file); // { url, key }
urlInput.value = res.url;
const src = res.url.startsWith('http') ? res.url : (API() + res.url);
preview.src = src; preview.style.display = 'block';
if (hint) hint.textContent = 'Фото завантажено ✅ URL підставлено';
} catch (e) {
alert('Помилка аплоаду: ' + e.message);
if (hint) hint.textContent = 'Помилка аплоаду';
} finally {
btn.disabled = false; btn.textContent = oldText;
}
});


async function apiUpload(file) {
const fd = new FormData(); fd.append('file', file);
const res = await fetch(API() + "/api/admin/upload", { method: 'POST', headers: setAuthHeader(), body: fd });
const text = await res.text();
if (!res.ok) { let msg = text; try { const j = JSON.parse(text); msg = j.error || text; } catch {} throw new Error(`Upload failed (${res.status}): ${msg}`); }
return JSON.parse(text);
}


function escapeHtml(str = '') { return str.replace(/[&<>"]+/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[s])); }


if (token) {
$('#loginView').classList.add('hidden');
$('#adminView').classList.remove('hidden');
loadGifts();
loadAssigns();
}