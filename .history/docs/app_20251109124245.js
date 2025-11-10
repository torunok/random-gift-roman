const API = () => window.API_BASE?.replace(/\/$/, '') || '';
const stage = document.getElementById('stage');
const consentModal = document.getElementById('consentModal');
const inputName = document.getElementById('inputName');
const checkboxAgree = document.getElementById('checkboxAgree');
const btnAgree = document.getElementById('btnAgree');
const btnPass = document.getElementById('btnPass');

// Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const el = (html) => { const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstElementChild; };

function showConsent(){
  consentModal.setAttribute('aria-hidden','false');
}
function hideConsent(){
  consentModal.setAttribute('aria-hidden','true');
}

checkboxAgree?.addEventListener('change',()=>{
  btnAgree.disabled = !(checkboxAgree.checked && inputName.value.trim().length>=2);
});
inputName?.addEventListener('input',()=>{
  btnAgree.disabled = !(checkboxAgree.checked && inputName.value.trim().length>=2);
});

btnPass?.addEventListener('click',()=>{
  const msg = el(`<div class="card fade-in"><h2>Дякую за щирість! Гарного дня 😄</h2></div>`);
  stage.innerHTML=''; stage.appendChild(msg); hideConsent();
  fetch(API()+"/api/agree",{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:"PASS"})}).catch(()=>{});
});

btnAgree?.addEventListener('click', async ()=>{
  const name = inputName.value.trim();
  if(!name) return;
  // Реєстрація згоди
  await fetch(API()+"/api/agree",{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}).catch(()=>{});
  hideConsent();
  // Перевірити, чи вже є призначення
  const me = await fetch(API()+"/api/me").then(r=>r.json()).catch(()=>null);
  if(me && me.assigned){
    return renderFinal(me.gift, me.name, me.telegram);
  }
  renderIntro(name);
});

function renderIntro(name){
  stage.innerHTML='';
  const block = el(`
    <div class="intro fade-in">
      <div class="photo slide-left"><img src="./images/roman.jpg" alt="Roman"/></div>
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

async function startRandom(){
  stage.innerHTML='';
  const blackout = el(`<div class="full-black">... </div>`);
  stage.appendChild(blackout);
  await sleep(2000);
  blackout.textContent = 'Все ґуд, це просто такий ефект)';
  await sleep(700);
  for(let i=5;i>=1;i--){ blackout.textContent = String(i); await sleep(700); }

  // Отримати/призначити подарунок
  const res = await fetch(API()+"/api/random").then(r=>r.json());
  stage.innerHTML='';

  // Показ подарунку
  const giftCenter = el(`
    <div class="center">
      <img class="gift-img scale-in" id="giftImg" src="${escapeHtml(res.gift.imageUrl||'')}" alt="gift"/>
    </div>
  `);
  stage.appendChild(giftCenter);

  await sleep(3000);

  // Зменшуємо картинку і додаємо опис праворуч
  stage.innerHTML='';
  const wrap = el(`
    <div class="gift-wrap fade-in">
      <img class="gift-img" src="${escapeHtml(res.gift.imageUrl||'')}" alt="gift"/>
      <div class="gift-desc">
        <h3>${escapeHtml(res.gift.title||'Подарунок')}</h3>
        <p>${escapeHtml(res.gift.description||'Опис')}</p>
      </div>
    </div>
  `);
  stage.appendChild(wrap);

  await sleep(10000);

  const moreBtn = el(`<div class="center"><button id="btnMore" class="btn btn-ghost">І це все?</button></div>`);
  stage.appendChild(moreBtn);
  moreBtn.querySelector('#btnMore').addEventListener('click', showThanksForm);
}

function showThanksForm(){
  stage.innerHTML='';
  const view = el(`
    <div class="intro fade-in">
      <div class="photo slide-left"><img src="./images/roman.jpg" alt="Roman"/></div>
      <div class="text slide-right">
        <h2>Щиро вдячний!</h2>
        <p>Буду радий розділити цей момент із вами. А поки запишіть свій нік у Telegram, щоб я пізніше повідомив дату, місце та час).</p>
      </div>
    </div>
  `);
  const form = el(`
    <div class="card fade-in" style="margin-top:16px;">
      <label class="field"><span>Ваш Telegram-нік</span>
        <input id="tgNick" type="text" placeholder="@nickname" />
      </label>
      <div class="actions center"><button id="btnMeet" class="btn btn-primary">Зустрінемось</button></div>
    </div>
  `);
  stage.append(view, form);
  setTimeout(()=>form.classList.add('scale-in'), 500);
  form.querySelector('#btnMeet').addEventListener('click', finalizeUser);
}

async function finalizeUser(){
  const nick = document.getElementById('tgNick').value.trim();
  if(nick.length < 3){ alert('Вкажіть коректний нік (3+ символи)'); return; }
  await fetch(API()+"/api/finalize",{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegram:nick})});
  // Після фіналізації показуємо фінальний екран
  const me = await fetch(API()+"/api/me").then(r=>r.json()).catch(()=>null);
  if(me && me.assigned){
    return renderFinal(me.gift, me.name, me.telegram);
  }
}

function renderFinal(gift, name, tg){
  stage.innerHTML='';
  const block = el(`
    <div class="gift-wrap fade-in">
      <img class="gift-img" src="${escapeHtml(gift.imageUrl||'')}" alt="gift"/>
      <div class="gift-desc">
        <h3>${escapeHtml(gift.title||'Подарунок')}</h3>
        <p>${escapeHtml(gift.description||'Опис')}</p>
        <hr style="border-color:#222;margin:12px 0;"/>
        <div style="display:flex;align-items:center;gap:10px;">
          <img src="./images/roman.jpg" alt="Roman" style="width:64px;height:64px;border-radius:10px;object-fit:cover"/>
          <div>
            <div><strong>Для:</strong> ${escapeHtml(name||'Друг')}</div>
            ${tg?`<div><strong>Telegram:</strong> ${escapeHtml(tg)}</div>`:''}
          </div>
        </div>
      </div>
    </div>
  `);
  stage.appendChild(block);
}

// Маленький escape
function escapeHtml(str=''){return str.replace(/[&<>"]+/g,s=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[s]));}

// При завантаженні: якщо вже є призначення — показати одразу
(async function init(){
  showConsent();
  try{
    const me = await fetch(API()+"/api/me").then(r=>r.json());
    if(me && me.assigned){
      hideConsent();
      return renderFinal(me.gift, me.name, me.telegram);
    }
  }catch(e){}
})();