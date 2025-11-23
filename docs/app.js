// ========== БАЗА ==========
const API = () => (window.API_BASE || '').replace(/\/$/, '');
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const stage = $('#stage');
const consentModal = $('#consentModal');
const inputName = $('#inputName');
const inputTelegram = $('#inputTelegram');
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
  btnAgree.disabled = !canSubmitConsent();
});
inputName?.addEventListener('input', () => {
  btnAgree.disabled = !canSubmitConsent();
});
inputTelegram?.addEventListener('input', () => {
  btnAgree.disabled = !canSubmitConsent();
});

function canSubmitConsent() {
  const nameOk = inputName && inputName.value.trim().length >= 2;
  const tgValueRaw = inputTelegram ? inputTelegram.value.trim() : '';
  const tgValue = tgValueRaw.replace(/^@/, '');
  const tgOk = /^[a-zA-Z0-9_]{3,}$/.test(tgValue);
  return checkboxAgree?.checked && nameOk && tgOk;
}

btnPass?.addEventListener('click', () => {
  const msg = el(`<div class="card fade-in"><h2>Дякую за щирість! Гарного дня 😄</h2></div>`);
  stage.innerHTML = ''; stage.appendChild(msg); hideConsent();
  api('/api/agree', { method: 'POST', body: JSON.stringify({ name: 'PASS' }) }).catch(() => {});
});

btnAgree?.addEventListener('click', async () => {
  const name = inputName.value.trim();
  const tgRaw = (inputTelegram?.value || '').trim();
  const tgCheck = tgRaw.replace(/^@/, '');
  if (!name || tgCheck.length < 3) return;

  try {
    await api('/api/agree', { method: 'POST', body: JSON.stringify({ name, telegram: tgRaw }) });
  } catch (e) {
    console.warn('agree failed:', e.message);
  }

  hideConsent();

  // якщо вже є призначення — показуємо фінал або просимо Telegram, якщо він відсутній
  try {
    const me = await api('/api/me', { method: 'GET' });
    if (me && me.assigned) {
      return renderFinal(me.gift);
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
  const blackout = el(
    `<div id="blackOverlay" class="full-black ease-slow">
      <div class="dice-grid">
        <div class="dice-face" id="diceFace">🎲</div>
        <div class="dice-caption" id="diceCaption">Готуємо кубики...</div>
      </div>
    </div>`
  );
  return blackout;
}

async function startRandom() {
  stage.innerHTML = '';
  const blackout = makeOverlay();
  stage.appendChild(blackout);

  const diceEl = $('#diceFace');
  const capEl = $('#diceCaption');
  const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  capEl.textContent = 'Кидаємо кубики...';
  for (let i = 0; i < 8; i++) {
    const face = faces[Math.floor(Math.random() * faces.length)];
    diceEl.textContent = face;
    diceEl.classList.toggle('spin');
    await sleep(200 + i * 40);
  }
  capEl.textContent = 'Полетіло!';
  await sleep(400);

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
  if (!gift || !gift.image) {
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
      <img class="gift-img scale-in" id="giftImgCenter" src="${escapeHtml(absoluteUrl(gift.image))}" alt="gift"/>
    </div>
  `);
  stage.appendChild(first);
  await sleep(3000);

  // 2) фото + опис + кнопка ПІД описом (22px)
  stage.innerHTML = '';
  const wrap = el(`
    <div class="gift-wrap fade-in">
      <img class="gift-img" src="${escapeHtml(absoluteUrl(gift.image))}" alt="gift"/>
      <div class="gift-desc">
        <h3>${escapeHtml(gift.name || 'Подарунок')}</h3>
        <p>${escapeHtml(gift.description || 'Опис')}</p>
      </div>
    </div>
  `);
  stage.appendChild(wrap);
}

function renderFinal(gift) {
  stage.innerHTML = '';
  const block = el(`
    <div class="gift-wrap fade-in ease-slow">
      <img class="gift-img" src="${escapeHtml(absoluteUrl(gift.image || ''))}" alt="gift"/>
      <div class="gift-desc">
        <h3>${escapeHtml(gift.name || 'Подарунок')}</h3>
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
      return renderFinal(me.gift);
    }
  } catch {}
})();
