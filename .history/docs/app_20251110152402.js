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

// Валідація Telegram-ніка
function isValidTg(nick = '') {
  const n = nick.trim();
  return /^@?[A-Za-z0-9_]{3,32}$/.test(n);
}

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
    // офлайн / розірване з'єднання
    throw new Error('Немає інтернету або сервер недоступний');
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* залишимо як {} */ }
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
  // відносні шляхи (наприклад, /img/gifts/....webp) — префіксуємо Worker'ом
  return API() + u;
}

// ====== CONSENT ======
function showConsent() { consentModal?.setAttribute('aria-hidden', 'false'); }
function hideConsent() { consentModal?.setAttribute('aria-hidden', 'true'); }

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
    // навіть якщо не відпрацює — дамо юзеру рухатись далі
    console.warn('agree failed:', e.message);
  }

  hideConsent();

  // якщо вже є призначення — показуємо фінал або вимагаємо Telegram
  try {
    const me = await api('/api/me', { method: 'GET' });
    if (me && me.assigned) {
      if (!me.telegram) return showThanksForm();
      return renderFinal(me.gift, me.name, me.telegram);
    }
  } catch { /* тихо */ }

  renderIntro(name);
});

// ====== СЦЕНИ ======
function renderIntro(name) {
  stage.innerHTML = '';
  const block = el(`
    <div class="intro fade-in">
      <div class="photo slide-left"><img src="./images/roman.png" alt="Roman"/></div>
      <div class="text slide-right">
        <h2>Привітик, ${escapeHtml(name)}! Тут все просто 🙂</h2>
        <p>Буде рандом, який обере подарунок, який ти повинен подарувати мені на день народження.
        Нагадаю, це буде <strong>28 листопада</strong>.</p>
        <button id="btnGo" class="btn btn-primary">Даю добро на рандом!</button>
      </div>
    </div>
  `);
  stage.appendChild(block);
  block.querySelector('#btnGo').addEventListener('click', startRandom);
}

function makeOverlay() {
  const blackout = el(`<div id="blackOverlay" class="full-black">...</div>`);
  return blackout;
}

async function startRandom() {
  stage.innerHTML = '';
  // чорний екран ефект
  const blackout = makeOverlay();
  stage.appendChild(blackout);

  // ефект + підказка
  await sleep(2000);
  blackout.textContent = 'Все ґуд, це просто такий ефект)';

  // відлік 5..1
  await sleep(700);
  for (let i = 5; i >= 1; i--) {
    blackout.textContent = String(i);
    await sleep(700);
  }

  // тягнемо подарунок
  let res;
  try {
    res = await api('/api/random', { method: 'GET' }); // {gift} або {already:true,gift}
  } catch (e) {
    $('#blackOverlay')?.remove();
    alert('Помилка під час отримання подарунка: ' + e.message);
    return;
  }

  const gift = res?.gift || (res?.already ? res.gift : null);
  if (!gift || !gift.imageUrl) {
    $('#blackOverlay')?.remove();
    if (res && res.error === 'no_active_gifts') {
      alert('Немає активних подарунків. Увімкни хоча б один у адмінці.');
    } else {
      alert('Подарунок не отримано. Спробуй ще раз або перевір дані в адмінці.');
    }
    return;
  }

  // прибираємо чорний екран і запускаємо послідовність показу
  $('#blackOverlay')?.remove();
  await showGiftSequence(gift);
}

// коротка послідовність: центр фото → потім фото + опис
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

  // 2) зменшити фото і додати опис праворуч
  stage.innerHTML = '';
  const wrap = el(`
    <div class="gift-wrap fade-in">
      <img class="gift-img" src="${escapeHtml(absoluteUrl(gift.imageUrl))}" alt="gift"/>
      <div class="gift-desc">
        <h3>${escapeHtml(gift.title || 'Подарунок')}</h3>
        <p>${escapeHtml(gift.description || 'Опис')}</p>
      </div>
    </div>
  `);
  stage.appendChild(wrap);

  // 3) через 10с показати кнопку переходу далі
  await sleep(10000);
  const moreBtn = el(`<div class="center"><button id="btnMore" class="btn btn-ghost">І це все?</button></div>`);
  stage.appendChild(moreBtn);
  moreBtn.querySelector('#btnMore').addEventListener('click', showThanksForm);
}

function showThanksForm() {
  stage.innerHTML = '';
  const view = el(`
    <div class="intro fade-in">
      <div class="photo slide-left"><img src="./images/roman.png" alt="Roman"/></div>
      <div class="text slide-right">
        <h2>Щиро вдячний!</h2>
        <p>Буду радий розділити цей момент із вами. А поки запишіть свій нік у Telegram, щоб я пізніше повідомив дату, місце та час).</p>
      </div>
    </div>
  `);
  const form = el(`
    <div class="card fade-in" style="margin-top:16px;">
      <label class="field"><span>Ваш Telegram-нік</span>
        <input id="tgNick" type="text" placeholder="@nickname" required />
        <small class="muted">Формат: @username, 3–32 символи (латиниця, цифри, _)</small>
      </label>
      <div class="actions center"><button id="btnMeet" class="btn btn-primary" disabled>Зустрінемось</button></div>
    </div>
  `);
  stage.append(view, form);
  setTimeout(() => form.classList.add('scale-in'), 500);

  const tgInput = $('#tgNick');
  const btn = form.querySelector('#btnMeet');
  tgInput.addEventListener('input', () => {
    btn.disabled = !isValidTg(tgInput.value);
  });
  btn.addEventListener('click', finalizeUser);
}

async function finalizeUser() {
  const inp = $('#tgNick');
  let nick = (inp?.value || '').trim();
  if (!isValidTg(nick)) { alert('Вкажіть коректний Telegram-нік (3–32 символи, латиниця/цифри/_).'); return; }
  if (!nick.startsWith('@')) nick = '@' + nick;

  try {
    await api('/api/finalize', { method: 'POST', body: JSON.stringify({ telegram: nick }) });
  } catch (e) {
    alert('Не вдалося зберегти нік: ' + e.message);
    return;
  }

  try {
    const me = await api('/api/me', { method: 'GET' });
    if (me && me.assigned) return renderFinal(me.gift, me.name, me.telegram);
  } catch (e) {
    alert('Не вдалося отримати фінальні дані: ' + e.message);
  }
}

function renderFinal(gift, name, tg) {
  stage.innerHTML = '';
  const block = el(`
    <div class="gift-wrap fade-in">
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

  // якщо юзер вже має призначення — показати одразу (але вимагати Telegram, якщо його ще нема)
  try {
    const me = await api('/api/me', { method: 'GET' });
    if (me && me.assigned) {
      hideConsent();
      if (!me.telegram) return showThanksForm();
      return renderFinal(me.gift, me.name, me.telegram);
    }
  } catch {
    // може бути офлайн/сервер недоступний — просто чекаємо взаємодії
  }
})();
