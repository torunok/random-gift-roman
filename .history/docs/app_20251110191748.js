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
        <button id="btnMore" class="btn btn-ghost" style="margin-top:22px;">І це все?</button>
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
        <p>Буду радий розділити цей момент із вами. А поки запишіть свій нік у Telegram, щоб я пізніше повідомив дату, місце та час).</p>
      </div>
    </div>
  `);

  const form = el(`
    <div class="card fade-in ease-slow" style="margin-top:16px;">
      <label class="field"><span>Ваш Telegram-нік</span>
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
