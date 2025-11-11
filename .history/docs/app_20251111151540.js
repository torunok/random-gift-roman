// ========== УТИЛІТИ ==========
const API = () => (window.API_BASE || '').replace(/\/$/, '');
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function el(html) {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
}
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[s]);
}

// ========== ЕЛЕМЕНТИ ==========
const stage = $('#stage');
const consentModal = $('#consentModal');
const inputName = $('#inputName');
const checkboxAgree = $('#checkboxAgree');
const btnAgree = $('#btnAgree');
const btnPass = $('#btnPass');

// ========== API-ОБГОРТКА ==========
async function api(path, { method = 'GET', body, headers } = {}) {
  const url = `${API()}${path}`;
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const errMsg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data;
}

// ========== UI ХЕЛПЕРИ ==========
function show(elm) { elm?.classList?.remove('hidden'); }
function hide(elm) { elm?.classList?.add('hidden'); }

function showConsent() {
  show(consentModal);
  consentModal.setAttribute('aria-hidden', 'false');
  // Фокус у модалку
  $('#btnAgree')?.focus();
}
function hideConsent() {
  // ВАЖЛИВО: спершу скидаємо фокус, щоби не було ARIA-попередження
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
  consentModal.setAttribute('aria-hidden', 'true');
  hide(consentModal);
}

function renderIntro(name = '') {
  stage.innerHTML = `
    <section class="card">
      <h1 class="h1">Привіт${name ? `, ${escapeHtml(name)}` : ''}! 🎁</h1>
      <p class="muted">Натискайте, щоб отримати випадковий подарунок.</p>
      <button id="btnStart" class="btn btn-primary">Запустити рандом</button>
    </section>
  `;
  $('#btnStart')?.addEventListener('click', startRandom);
}

function renderCountdown(ms = 3000) {
  stage.innerHTML = `
    <section class="card center">
      <div id="count" class="count">3</div>
      <p class="muted">Обираємо для вас подарунок…</p>
    </section>
  `;
  const count = $('#count');
  let sec = Math.ceil(ms / 1000);
  count.textContent = String(sec);
  const t = setInterval(() => {
    sec -= 1;
    if (sec <= 0) {
      clearInterval(t);
    }
    count.textContent = String(Math.max(sec, 0));
  }, 1000);
}

function renderGift(gift) {
  stage.innerHTML = `
    <section class="card gift">
      <img class="gift-image" src="${escapeHtml(gift.imageUrl)}" alt="${escapeHtml(gift.title || 'Gift')}" />
      <h2 class="h2">${escapeHtml(gift.title || 'Подарунок')}</h2>
      ${gift.description ? `<p>${escapeHtml(gift.description)}</p>` : ''}
      <button id="btnGet" class="btn btn-primary">Дякую!</button>
    </section>
  `;
  $('#btnGet')?.addEventListener('click', showThanksForm);
}

function showThanksForm() {
  stage.innerHTML = `
    <section class="card">
      <h2 class="h2">Ще хвилинка</h2>
      <p class="muted">Залиште ваш Telegram для звʼязку.</p>
      <div class="field">
        <label for="tgInput">Telegram</label>
        <input id="tgInput" type="text" placeholder="@nickname" />
      </div>
      <button id="btnSendTg" class="btn btn-primary">Відправити</button>
    </section>
  `;
  $('#btnSendTg')?.addEventListener('click', async () => {
    const tg = ($('#tgInput')?.value || '').trim();
    try {
      await api('/api/telegram', { method: 'POST', body: { telegram: tg } });
      stage.innerHTML = `
        <section class="card center">
          <h2 class="h2">Готово! ✅</h2>
          <p class="muted">Дякуємо, з вами звʼяжуться.</p>
        </section>
      `;
    } catch (e) {
      alert(e.message || 'Помилка відправки Telegram');
    }
  });
}

// ========== ЛОГІКА ==========
async function startRandom() {
  // Показуємо простий countdown (бек також може віддати duration)
  renderCountdown(3000);

  try {
    const res = await api('/api/random', { method: 'GET' });
    // Успішний шлях
    if (res && res.gift && res.gift.imageUrl) {
      // якщо бек віддає duration — дочекаємося гарної анімації
      const waitMs = Number(res.duration) > 0 ? Number(res.duration) : 1200;
      await sleep(waitMs);
      return renderGift(res.gift);
    }

    // Якщо бек відповів сигнальною помилкою — покажемо нормальне повідомлення
    if (res && (res.error === 'no_stock' || res.error === 'no_active_gifts')) {
      stage.innerHTML = `
        <section class="card center">
          <h2 class="h2">Поки що подарунків немає</h2>
          <p class="muted">Додайте або активуйте подарунки з наявністю (<code>stock &gt; 0</code>) в адмінці.</p>
        </section>
      `;
      return;
    }

    // Запасний випадок
    throw new Error('Подарунок не отримано. Спробуйте ще раз.');
  } catch (e) {
    console.error('Помилка під час отримання подарунка:', e);
    alert('500 від API або тимчасова помилка. Перевірте, чи задеплоєний свіжий воркер і чи є колонка stock.');
  }
}

// ========== ЗГОДА ==========
function initConsent() {
  if (!consentModal) return;
  const ok = localStorage.getItem('consent_ok') === '1';
  if (!ok) {
    showConsent();
  }
  btnAgree?.addEventListener('click', () => {
    const name = (inputName?.value || '').trim();
    const agreed = !!checkboxAgree?.checked;

    if (!name) return alert('Введіть ім’я');
    if (!agreed) return alert('Підтвердіть згоду');

    localStorage.setItem('user_name', name);
    localStorage.setItem('consent_ok', '1');
    hideConsent();
    renderIntro(name);
  });

  btnPass?.addEventListener('click', () => {
    localStorage.setItem('consent_ok', '1');
    hideConsent();
    renderIntro(localStorage.getItem('user_name') || '');
  });
}

// ========== СТАРТ ==========
window.addEventListener('DOMContentLoaded', async () => {
  try {
    // Якщо користувач уже має призначений подарунок
    const me = await api('/api/me', { method: 'GET' });
    if (me && me.assigned) {
      if (me.telegram && String(me.telegram).trim().length >= 3) {
        return renderGift(me.gift || {});
      } else {
        return showThanksForm();
      }
    }
  } catch {
    // ігноруємо — значить ще не призначали
  }
  initConsent();
  const name = localStorage.getItem('user_name') || '';
  if (localStorage.getItem('consent_ok') === '1') {
    renderIntro(name);
  }
});
