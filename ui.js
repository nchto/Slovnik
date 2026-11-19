(() => {
"use strict";
const S = window.Slovnik;
const { DAY, dayStart, dayKey, shuffle, serialize, deserialize, newCard, schedule, fmtInterval, counts, nextCard, nextLearnDue, checkAnswer } = S;

const state = { decks: {}, stats: { goal: 20, days: {} }, view: { name: "home" }, store: null, ready: false, flash: null, undo: null, imp: null, test: null, quoteShift: 0 };
const app = document.getElementById("app"), syncEl = document.getElementById("sync"), tabs = document.getElementById("tabs");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const setSync = t => { syncEl.textContent = t; };
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many; };
const hue = s => { let h = 0; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 360; return h; };

/* ---------- storage ---------- */
function makeLocalStore() {
  const KEY = "slovnik-decks", SKEY = "slovnik-stats";
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") || d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  return {
    kind: "local",
    start(onDecks, onStats) {
      const raw = read(KEY, {}), out = {};
      for (const [id, v] of Object.entries(raw)) out[id] = v.cards && v.cards[0] && Array.isArray(v.cards[0]) ? deserialize(id, v) : deserialize(id, serialize(v));
      onDecks(out, false); onStats(read(SKEY, { goal: 20, days: {} }));
    },
    save(deck) { const all = read(KEY, {}); all[deck.id] = serialize(deck); if (!write(KEY, all)) setSync("Браузер не дал сохранить: закончилось место. Войдите в аккаунт, чтобы хранить большие колоды"); },
    remove(id) { const all = read(KEY, {}); delete all[id]; write(KEY, all); },
    saveStats(st) { write(SKEY, st); }
  };
}

function makeDbStore(db, userId) {
  const base = "data/users/" + userId + "/srs/";
  const metaPath = id => base + "decks/" + id, chunkPath = (id, k) => base + "chunks/" + id + "_" + k;
  const chunkPrefix = id => base + "chunks/" + id + "_";
  const statsPath = "data/users/" + userId + "/stats";
  const saved = new Map();
  let queue = new Map(), inflight = null, timer = null, failed = "";
  const intended = path => queue.has(path) ? queue.get(path).json : saved.get(path);
  const busyDecks = () => { const b = new Set(); for (const e of queue.values()) if (e.deck) b.add(e.deck); if (inflight && inflight.deck) b.add(inflight.deck); return b; };
  function status() {
    const left = queue.size + (inflight ? 1 : 0);
    if (failed) setSync(failed);
    else if (left) setSync(left > 2 ? "Сохраняю… осталось частей: " + left : "Сохраняю…");
    else setSync("Сохранено");
  }
  function enqueue(path, entry) { queue.delete(path); queue.set(path, entry); kick(900); }
  function kick(delay) { if (!timer && !inflight) timer = setTimeout(work, delay); status(); }
  async function work() {
    timer = null;
    const first = queue.entries().next();
    if (first.done) { status(); return; }
    const [path, e] = first.value; queue.delete(path); inflight = { path, ...e }; status();
    let wait = 40;
    try {
      if (e.op === "del") { await db.doc(path).delete(); saved.delete(path); }
      else { await db.doc(path).set(e.data); saved.set(path, e.json); }
      failed = "";
    } catch (err) {
      const code = err && err.code;
      if (code === "unavailable" || code === "resource_exhausted") {
        if (!queue.has(path)) queue = new Map([[path, e], ...queue]);
        wait = code === "unavailable" ? 1500 + Math.random() * 1500 : 6000;
      } else if (code === "quota_exceeded") failed = "Хранилище заполнено. Удалите ненужные колоды, и сохранение продолжится";
      else if (code === "invalid_argument") failed = "Одна карточка слишком большая для сохранения";
      else failed = "Не удалось сохранить изменения";
    } finally { inflight = null; }
    if (queue.size) timer = setTimeout(work, wait);
    status();
  }
  const flushAll = () => { if (timer && !inflight) { clearTimeout(timer); timer = null; work(); } };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushAll(); });
  window.addEventListener("pagehide", flushAll);

  let metas = null, chunks = null, onDecksCb = null;
  function assemble(fromCache) {
    if (!metas || !chunks) return;
    const busy = busyDecks(), out = {};
    const byDeck = new Map();
    for (const [id, v] of chunks) {
      const cut = id.lastIndexOf("_"), deck = id.slice(0, cut), k = +id.slice(cut + 1);
      if (!byDeck.has(deck)) byDeck.set(deck, []);
      byDeck.get(deck).push([k, v.cards || []]);
    }
    for (const [id, v] of metas) {
      if (busy.has(id)) { if (state.decks[id]) out[id] = state.decks[id]; continue; }
      const deck = deserialize(id, { ...v, cards: v.cards || [] });
      if (!v.cards) {
        const parts = (byDeck.get(id) || []).sort((a, b) => a[0] - b[0]);
        deck.cards = parts.flatMap(([k, rows]) => rows.map(r => S.cardFromRow(r, k)));
      }
      out[id] = deck;
    }
    for (const id of busy) if (!out[id] && state.decks[id] && queue.get(metaPath(id))?.op !== "del") out[id] = state.decks[id];
    onDecksCb(out, fromCache);
  }
  return {
    kind: "db",
    start(onDecks, onStats, onTimeout, onError) {
      onDecksCb = onDecks;
      const t = setTimeout(onTimeout, 10000);
      let metaLive = false, chunkLive = false;
      const live = () => { if (metaLive && chunkLive) clearTimeout(t); };
      db.collection(base + "decks").onSnapshot(snap => {
        if (!snap.metadata.fromCache) { metaLive = true; live(); }
        metas = new Map();
        snap.docs.forEach(d => { const v = d.data(); if (!v) return; metas.set(d.id, v); saved.set(metaPath(d.id), v.cards ? "legacy" : JSON.stringify(S.deckMeta(v))); });
        assemble(snap.metadata.fromCache);
      }, e => { clearTimeout(t); onError(e); });
      db.collection(base + "chunks").onSnapshot(snap => {
        if (!snap.metadata.fromCache) { chunkLive = true; live(); }
        chunks = new Map();
        snap.docs.forEach(d => { const v = d.data(); if (!v) return; chunks.set(d.id, v); saved.set(base + "chunks/" + d.id, JSON.stringify(v.cards || [])); });
        assemble(snap.metadata.fromCache);
      }, e => { clearTimeout(t); onError(e); });
      db.doc(statsPath).onSnapshot(snap => {
        const v = snap.exists ? snap.data() : null;
        const q = queue.get(statsPath);
        onStats(q ? q.data : v ? { goal: v.goal || 20, days: v.days || {} } : { goal: 20, days: {} });
      }, () => {});
    },
    save(deck) {
      const groups = S.packChunks(deck), keep = new Set();
      for (const [k, cards] of groups) {
        const path = chunkPath(deck.id, k); keep.add(path);
        const rows = cards.map(S.cardRow), json = JSON.stringify(rows);
        if (intended(path) !== json) enqueue(path, { op: "set", data: { deck: deck.id, k, cards: rows }, json, deck: deck.id });
      }
      const prefix = chunkPrefix(deck.id);
      for (const path of new Set([...saved.keys(), ...queue.keys()])) {
        if (path.startsWith(prefix) && !keep.has(path) && queue.get(path)?.op !== "del" && (saved.has(path) || queue.has(path))) {
          if (saved.has(path)) enqueue(path, { op: "del", deck: deck.id }); else queue.delete(path);
        }
      }
      const meta = S.deckMeta(deck), mj = JSON.stringify(meta);
      if (intended(metaPath(deck.id)) !== mj) enqueue(metaPath(deck.id), { op: "set", data: meta, json: mj, deck: deck.id });
    },
    remove(id) {
      const prefix = chunkPrefix(id);
      for (const path of new Set([...saved.keys(), ...queue.keys()])) {
        if (!path.startsWith(prefix)) continue;
        if (saved.has(path)) enqueue(path, { op: "del", deck: id }); else queue.delete(path);
      }
      enqueue(metaPath(id), { op: "del", deck: id });
    },
    saveStats(st) { enqueue(statsPath, { op: "set", data: st, json: JSON.stringify(st), deck: null }); }
  };
}

/* ---------- mutations ---------- */
function saveDeck(deck) { state.decks[deck.id] = deck; state.store.save(deck); }
function saveStats() { state.store.saveStats(JSON.parse(JSON.stringify(state.stats))); }
function createDeck(name, cards = []) {
  const deck = { id: S.uid(), name, created: Date.now(), newPerDay: S.DEFAULT_NEW_PER_DAY, reverse: false, typeIn: false, newDay: "", newDone: 0, cards };
  saveDeck(deck); return deck;
}
const deckList = () => Object.values(state.decks).sort((a, b) => a.created - b.created);

/* ---------- speech ---------- */
function speak(text) {
  try {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[а-яё]/i.test(text) ? "ru-RU" : /[äöüß]/i.test(text) ? "de-DE" : /[ñ¿¡]/i.test(text) ? "es-ES" : /[àâçéèêëîïôûùœ]/i.test(text) ? "fr-FR" : /[぀-ヿ]/.test(text) ? "ja-JP" : /[一-鿿]/.test(text) ? "zh-CN" : /[가-힯]/.test(text) ? "ko-KR" : "en-US";
    u.rate = 0.9; speechSynthesis.speak(u);
  } catch {}
}

/* ---------- icons ---------- */
const I = {
  speak: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 3.5-1.5 5.5-3 7.5C7.5 11.6 7 13 7 14.5A5 5 0 0 0 17 15c0-2.6-1.4-4.3-2.4-5.6.1 1.5-.4 2.6-1.4 3.1.3-3.6-.2-7.2-1.2-10.5z"/></svg>',
  choice: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></svg>',
  type: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>',
  pairs: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><path d="M10 7h4a3 3 0 0 1 3 3v4"/></svg>'
};
const SAMPLE = [["apple","яблоко"],["to borrow","брать взаймы"],["to lend","давать взаймы"],["although","хотя"],["to achieve","достигать"],["reliable","надёжный"],["to improve","улучшать"],["opportunity","возможность"],["to suggest","предлагать"],["enough","достаточно"],["to own","владеть"],["weather","погода"],["to remember","помнить"],["to forget","забывать"],["neighbour","сосед"],["to explain","объяснять"],["purpose","цель, назначение"],["to require","требовать"],["obvious","очевидный"],["to avoid","избегать"]];

/* ---------- navigation ---------- */
const TAB_OF = { home: "home", deck: "home", new: "home", import: "home", tests: "tests", testresult: "tests", progress: "progress" };
function go(view) { state.view = view; render(); window.scrollTo(0, 0); }
function render() {
  if (!state.ready) return;
  const v = state.view;
  const tab = TAB_OF[v.name];
  tabs.hidden = !tab; document.body.classList.toggle("with-tabs", !!tab);
  tabs.querySelectorAll("button").forEach(b => { if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  if (v.name === "study" && state.decks[v.deck]) return renderStudy();
  if (v.name === "deck" && state.decks[v.deck]) return renderDeck();
  if (v.name === "new") return renderNewDeck();
  if (v.name === "import") return renderImport();
  if (v.name === "tests") return renderTestSetup();
  if (v.name === "testrun" && state.test) return renderTestRun();
  if (v.name === "testresult" && state.test) return renderTestResult();
  if (v.name === "progress") return renderProgress();
  state.view = { name: "home" }; renderHome();
}
tabs.addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) go({ name: b.dataset.tab }); });

/* ---------- home ---------- */
function todayStats() { return state.stats.days[dayKey(Date.now())] || {}; }
function renderHome() {
  const decks = deckList(), now = Date.now();
  const td = todayStats(), done = (td.r || 0), goal = Math.max(1, state.stats.goal || 20), st = S.streak(state.stats, now);
  const tot = decks.reduce((a, d) => { const c = counts(d, now); a.n += c.n; a.l += c.l; a.r += c.r; return a; }, { n: 0, l: 0, r: 0 });
  const pct = Math.min(1, done / goal), C = 2 * Math.PI * 38;
  const h = new Date().getHours(), hello = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  const qi = S.quoteIndex(now, state.quoteShift), [qt, qa] = S.QUOTES[qi];
  let html = "";
  if (state.flash && state.flash.until > now) html += `<p class="notice">${esc(state.flash.text)}</p>`;
  if (state.store.kind === "local") html += window.SlovnikCloud && window.SlovnikCloud.enabled
    ? `<div class="notice row between"><span>Вы без аккаунта: колоды хранятся только в этом браузере.</span><button class="btn" data-act="sign-in">Войти</button></div>`
    : window.claude ? `<p class="notice">Вы не вошли в аккаунт, поэтому колоды сохраняются только в этом браузере. Войдите в claude.ai, чтобы прогресс был на всех устройствах.</p>`
    : `<p class="notice">Колоды сохраняются только в этом браузере. Делайте резервную копию на вкладке «Прогресс».</p>`;
  html += `<section class="panel today">
    <div class="ring" role="img" aria-label="Цель дня: ${done} из ${goal}"><svg viewBox="0 0 88 88"><circle class="track" cx="44" cy="44" r="38" fill="none" stroke-width="9"/><circle class="val" cx="44" cy="44" r="38" fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/></svg><b>${done}</b></div>
    <div class="today-info"><h1>${hello}!</h1>
      <p class="muted small">${done >= goal ? "Цель дня выполнена. Можно продолжать или отдохнуть." : `Цель дня: ${goal} ${plural(goal, "ответ", "ответа", "ответов")}, осталось ${goal - done}.`}</p>
      <div class="row" style="gap:14px"><span class="streak">${I.flame}${st} ${plural(st, "день", "дня", "дней")} подряд</span>
      <span class="counts small"><span class="c-new">${tot.n}</span><span class="c-learn">${tot.l}</span><span class="c-due">${tot.r}</span></span></div>
    </div></section>
  <figure class="quote" style="margin:0"><span class="eyebrow">Цитата дня</span><blockquote>«${esc(qt)}»</blockquote><figcaption>${esc(qa)}</figcaption><button class="next" data-act="next-quote">Другая цитата</button></figure>
  <div class="row between"><h2>Мои колоды</h2><div class="row" style="gap:8px"><button class="btn ghost" data-act="import">Импорт файла</button><button class="btn" data-act="new">+ Колода</button></div></div>`;
  if (!decks.length) {
    html += `<div class="empty"><h2>Колод пока нет</h2><p class="muted">Создайте колоду из списка слов, импортируйте файл Anki (.apkg) или таблицу, или начните с примера.</p>
      <div class="row"><button class="btn" data-act="import">Импортировать файл</button><button class="btn ghost" data-act="new">Создать колоду</button><button class="btn ghost" data-act="sample">Пример: 20 английских слов</button></div></div>`;
  } else {
    html += `<div class="decks">` + decks.map(d => {
      const c = counts(d, now), any = c.n + c.l + c.r > 0;
      return `<div class="deck"><div class="badge" style="--h:${hue(d.name)}" aria-hidden="true">${esc([...d.name.trim()][0] || "?").toUpperCase()}</div>
        <div class="deck-name">${esc(d.name)} <span class="muted small">· ${c.total} ${plural(c.total, "карточка", "карточки", "карточек")}</span></div>
        <button class="btn" data-act="study" data-id="${d.id}" ${any ? "" : "disabled"}>${any ? "Учить" : "Готово"}</button>
        <div class="counts" title="Новые / На изучении / К повторению"><span class="c-new">Новые <b>${c.n}</b></span><span class="c-learn">Изучаю <b>${c.l}</b></span><span class="c-due">Повтор <b>${c.r}</b></span></div>
        <div class="deck-more"><button class="chip" data-act="deck" data-id="${d.id}">Карточки и настройки</button><button class="chip" data-act="quick-test" data-id="${d.id}">Тест по колоде</button></div></div>`;
    }).join("") + `</div>`;
  }
  app.innerHTML = html;
}

/* ---------- new deck ---------- */
function renderNewDeck() {
  app.innerHTML = `<div class="row"><button class="chip" data-act="home">← Назад</button></div>
  <form class="panel" id="newform"><h1>Новая колода</h1>
    <label>Название<input id="nd-name" required maxlength="80" placeholder="Например: English B1"></label>
    <label>Слова (можно добавить позже)<textarea id="nd-words" placeholder="apple — яблоко&#10;to borrow — брать взаймы&#10;reliable; надёжный"></textarea></label>
    <p class="muted small">Одна пара на строку. Разделитель: тире, точка с запятой, «=» или табуляция. Для файлов есть <button type="button" class="chip" data-act="import">импорт</button>.</p>
    <div class="row"><button class="btn" type="submit">Создать</button><span class="muted small" id="nd-count"></span></div></form>`;
  const ta = document.getElementById("nd-words"), cnt = document.getElementById("nd-count");
  ta.addEventListener("input", () => { const n = S.parseImport(ta.value).length; cnt.textContent = n ? `Распознано карточек: ${n}` : ""; });
  document.getElementById("newform").addEventListener("submit", e => {
    e.preventDefault();
    const name = document.getElementById("nd-name").value.trim(); if (!name) return;
    const d = createDeck(name, S.parseImport(ta.value).map(([f, b]) => newCard(f, b))); go({ name: "deck", deck: d.id });
  });
}

/* ---------- deck ---------- */
function stateLabel(c, now) {
  if (c.s === 0) return "новая";
  if (c.s === 1 || c.s === 3) return "изучаю";
  const d = Math.round((c.due - dayStart(now)) / DAY);
  return d <= 0 ? "сегодня" : "через " + d + " д";
}
function renderDeck() {
  const deck = state.decks[state.view.deck], now = Date.now(), edit = state.view.edit, c = counts(deck, now);
  const editing = edit && deck.cards.find(x => x.id === edit);
  app.innerHTML = `<div class="row between"><button class="chip" data-act="home">← Колоды</button><div class="row" style="gap:8px">${deck.cards.length >= 4 ? `<button class="btn ghost" data-act="quick-test" data-id="${deck.id}">Тест</button>` : ""}${c.n + c.l + c.r ? `<button class="btn" data-act="study" data-id="${deck.id}">Учить</button>` : ""}</div></div>
  <div class="panel">
    <label>Название колоды<input id="dk-name" value="${esc(deck.name)}" maxlength="80"></label>
    <div class="row">
      <label style="flex:1;min-width:130px">Новых слов в день<input id="dk-new" type="number" min="0" max="500" value="${deck.newPerDay ?? S.DEFAULT_NEW_PER_DAY}"></label>
      <label style="flex:1;min-width:170px">Сторона вопроса<select id="dk-rev"><option value="0" ${deck.reverse ? "" : "selected"}>Слово → перевод</option><option value="1" ${deck.reverse ? "selected" : ""}>Перевод → слово</option></select></label>
      <label style="flex:1;min-width:170px">Как отвечать<select id="dk-type"><option value="0" ${deck.typeIn ? "" : "selected"}>Вспомнить и проверить себя</option><option value="1" ${deck.typeIn ? "selected" : ""}>Вписать ответ</option></select></label>
    </div>
  </div>
  <form class="panel" id="addform"><h2>${editing ? "Изменить карточку" : "Добавить карточки"}</h2>
    ${editing ? `<label>Слово<textarea id="ed-f" style="min-height:60px">${esc(editing.f)}</textarea></label><label>Перевод<textarea id="ed-b" style="min-height:60px">${esc(editing.b)}</textarea></label><div class="row"><button class="btn" type="submit">Сохранить</button><button class="btn ghost" type="button" data-act="cancel-edit">Отмена</button></div>`
      : `<textarea id="add-words" placeholder="слово — перевод&#10;по одной паре на строку"></textarea><div class="row"><button class="btn" type="submit">Добавить</button><span class="muted small" id="add-count"></span></div>`}
  </form>
  <div class="panel">
    <div class="row between"><h2>Карточки · ${deck.cards.length}</h2>${deck.cards.length > 20 ? `<input id="cl-q" type="search" placeholder="Найти слово" value="${esc(state.view.q || "")}" style="max-width:220px">` : ""}</div>
    <div id="cl">${cardListHtml(deck, now)}</div>
  </div>
  <div class="panel"><div class="row between"><div><h3>Экспорт</h3><p class="muted small">Текстовый файл, который открывается в Anki через «Файл → Импорт».</p></div><button class="btn ghost" data-act="export" ${deck.cards.length ? "" : "disabled"}>Скачать .txt</button></div><p class="small" id="export-msg" hidden></p></div>
  <div class="panel"><div class="row" id="del-zone"><button class="btn danger" data-act="ask-del">Удалить колоду</button></div></div>`;
  const qI = document.getElementById("cl-q");
  if (qI) qI.addEventListener("input", () => { state.view.q = qI.value; state.view.limit = 100; document.getElementById("cl").innerHTML = cardListHtml(deck, Date.now()); });
  const nameI = document.getElementById("dk-name");
  nameI.addEventListener("change", () => { const n = nameI.value.trim(); if (n) { deck.name = n; saveDeck(deck); } });
  document.getElementById("dk-new").addEventListener("change", e => { deck.newPerDay = Math.max(0, Math.min(500, parseInt(e.target.value, 10) || 0)); saveDeck(deck); });
  document.getElementById("dk-rev").addEventListener("change", e => { deck.reverse = e.target.value === "1"; saveDeck(deck); });
  document.getElementById("dk-type").addEventListener("change", e => { deck.typeIn = e.target.value === "1"; saveDeck(deck); });
  const ta = document.getElementById("add-words");
  if (ta) ta.addEventListener("input", () => { const n = S.parseImport(ta.value).length; document.getElementById("add-count").textContent = n ? `Распознано: ${n}` : ""; });
  document.getElementById("addform").addEventListener("submit", e => {
    e.preventDefault();
    if (editing) {
      const f = document.getElementById("ed-f").value.trim(), b = document.getElementById("ed-b").value.trim();
      if (f && b) { editing.f = f; editing.b = b; saveDeck(deck); }
      state.view.edit = null; render();
    } else {
      const pairs = S.parseImport(ta.value); if (!pairs.length) return;
      deck.cards.push(...pairs.map(([f, b]) => newCard(f, b))); saveDeck(deck); render();
    }
  });
}
function cardListHtml(deck, now) {
  if (!deck.cards.length) return `<p class="muted">В колоде пока нет карточек.</p>`;
  const q = S.normalize(state.view.q || ""), limit = state.view.limit || 100;
  const list = q ? deck.cards.filter(x => S.normalize(x.f).includes(q) || S.normalize(x.b).includes(q)) : deck.cards;
  if (!list.length) return `<p class="muted">Ничего не нашлось.</p>`;
  return `<div class="cardlist">${list.slice(0, limit).map(x => `<div class="cl-row"><div>${esc(x.f)}</div><div class="b">${esc(x.b)}</div><div class="row acts" style="gap:6px;justify-content:flex-end"><span class="st">${stateLabel(x, now)}</span><button class="chip" data-act="edit" data-id="${x.id}">Изм.</button><button class="chip" data-act="del-card" data-id="${x.id}" aria-label="Удалить карточку">✕</button></div></div>`).join("")}</div>
    ${list.length > limit ? `<button class="btn ghost" data-act="more-cards" style="margin-top:10px">Показать ещё (${Math.min(100, list.length - limit)} из ${list.length - limit})</button>` : ""}`;
}
async function saveFile(filename, data, mime) {
  if (window.claude && window.claude.use) {
    const dl = await window.claude.use("downloads");
    if (!dl) throw { code: "unavailable" };
    await dl.save({ filename, data }); return;
  }
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const saveError = e => e && e.code === "declined" ? "Скачивание отменено." : e && e.code === "unavailable" ? "Скачивание недоступно в этом окне. Откройте страницу в браузере." : "Не удалось сохранить файл.";
async function exportDeck() {
  const deck = state.decks[state.view.deck], msg = document.getElementById("export-msg");
  const show = t => { msg.hidden = false; msg.textContent = t; };
  try {
    const name = deck.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "deck";
    await saveFile(name + ".txt", S.exportAnkiText(deck), "text/plain;charset=utf-8");
    show("Файл сохранён.");
  } catch (e) { show(saveError(e)); }
}
async function exportBackup() {
  const msg = document.getElementById("backup-msg");
  const show = t => { msg.hidden = false; msg.textContent = t; };
  const data = JSON.stringify({ format: "slovnik-backup", version: 1, exported: new Date().toISOString(), decks: deckList().map(d => ({ id: d.id, ...serialize(d) })), stats: state.stats });
  try { await saveFile("slovnik-backup-" + dayKey(Date.now()) + ".json", data, "application/json"); show("Резервная копия сохранена."); }
  catch (e) { show(saveError(e)); }
}
function restoreBackup() {
  const b = state.imp && state.imp.backup; if (!b) return;
  let decks = 0, cards = 0;
  for (const raw of b.decks) {
    if (!raw || typeof raw.id !== "string" || !Array.isArray(raw.cards)) continue;
    const d = deserialize(raw.id, raw); saveDeck(d); decks++; cards += d.cards.length;
  }
  const days = (b.stats && b.stats.days) || {};
  for (const [k, v] of Object.entries(days)) {
    const cur = state.stats.days[k] || (state.stats.days[k] = {});
    for (const [f, n] of Object.entries(v || {})) if (typeof n === "number") cur[f] = Math.max(cur[f] || 0, n);
  }
  if (b.stats && b.stats.goal && (!state.stats.goal || state.stats.goal === 20)) state.stats.goal = b.stats.goal;
  saveStats(); state.imp = null;
  state.flash = { until: Date.now() + 15000, text: `Восстановлено ${decks} ${plural(decks, "колода", "колоды", "колод")} и ${cards} ${plural(cards, "карточка", "карточки", "карточек")} вместе с прогрессом.` };
  go({ name: "home" });
}

/* ---------- import ---------- */
const LIBS = window.SLOVNIK_LIBS || {
  jszip: "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
  fzstd: "https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.js",
  sql: "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-asm-memory-growth.js"
};
const loadScript = src => new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Не удалось загрузить модуль чтения Anki. Проверьте интернет и попробуйте ещё раз.")); document.head.appendChild(s); });
let libsPromise = null;
function loadAnkiLibs() {
  if (!libsPromise) libsPromise = Promise.all([loadScript(LIBS.jszip), loadScript(LIBS.fzstd), loadScript(LIBS.sql)])
    .then(() => ({ JSZip: window.JSZip, fzstd: window.fzstd, initSqlJs: window.initSqlJs }))
    .catch(e => { libsPromise = null; throw e; });
  return libsPromise;
}
async function handleFile(file) {
  const imp = state.imp = { status: "loading", step: "Открываю файл…", fileName: file.name };
  render();
  const step = t => { imp.step = t; const el = document.getElementById("imp-step"); if (el) el.textContent = t; };
  try {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    let parsed;
    if (ext === "apkg" || ext === "colpkg") {
      step("Загружаю модуль чтения Anki (около 1,5 МБ, один раз)…");
      const libs = await loadAnkiLibs();
      const r = await S.readAnkiPackage(await file.arrayBuffer(), libs, step);
      parsed = { kind: "anki", crt: r.crt, media: r.media, scheduled: r.scheduled, groups: r.groups.map(g => ({ ...g, notes: g.notes.map(n => ({ ...n, deck: n.deck === "Default" ? "Основная колода из Anki" : n.deck })) })) };
    } else if (ext === "json") {
      let b = null; try { b = JSON.parse(await file.text()); } catch {}
      if (!b || b.format !== "slovnik-backup" || !Array.isArray(b.decks)) throw new Error("Это не резервная копия Словника. Подойдёт файл, скачанный кнопкой «Резервная копия» на вкладке «Прогресс».");
      Object.assign(imp, { status: "backup", backup: b, cards: b.decks.reduce((n, d) => n + ((d && d.cards) || []).length, 0) });
      if (state.view.name === "import") render();
      return;
    } else if (["txt", "csv", "tsv", "tab"].includes(ext)) {
      const t = S.parseTextFile(await file.text(), file.name);
      parsed = { kind: "text", scheduled: 0, groups: [{ name: "Таблица", fieldNames: t.fieldNames, notes: t.notes }] };
    } else throw new Error("Этот формат не поддерживается. Подойдут файлы .apkg, .colpkg, .txt, .csv и .tsv.");
    const total = parsed.groups.reduce((s, g) => s + g.notes.length, 0);
    if (!total) throw new Error("В файле не нашлось ни одной карточки.");
    Object.assign(imp, parsed, { status: "preview", total, keepSched: parsed.scheduled > 0, merge: false,
      mergeName: file.name.replace(/\.[^.]+$/, ""),
      maps: parsed.groups.map(g => ({ front: 0, back: g.fieldNames.length > 1 ? [1] : [], skip: false })) });
  } catch (e) { Object.assign(imp, { status: "error", error: e.message || "Не удалось прочитать файл." }); }
  if (state.view.name === "import") render();
}
function importPreviewHtml(imp) {
  const deckNames = new Set(); imp.groups.forEach(g => g.notes.forEach(n => deckNames.add(n.deck || imp.mergeName)));
  let html = `<div class="panel"><h1>${esc(imp.fileName)}</h1>
    <p class="muted">Найдено ${imp.total} ${plural(imp.total, "запись", "записи", "записей")}${imp.kind === "anki" ? `, ${deckNames.size} ${plural(deckNames.size, "колода", "колоды", "колод")}` : ""}.</p>
    ${imp.media ? `<p class="notice small">В колоде есть картинки и звуки. Пока переносится только текст, а слово можно озвучить кнопкой-динамиком.</p>` : ""}
  </div>`;
  imp.groups.forEach((g, gi) => {
    const mp = imp.maps[gi];
    const sample = g.notes.slice(0, 3);
    const opts = g.fieldNames.map((n, i) => `<option value="${i}" ${mp.front === i ? "selected" : ""}>${esc(n)}</option>`).join("");
    html += `<div class="panel">
      <div class="row between"><h2>${imp.groups.length > 1 ? esc(g.name) + " · " + g.notes.length : "Что показывать на карточке"}</h2>${imp.groups.length > 1 ? `<label class="check small"><input type="checkbox" data-imp="skip" data-g="${gi}" ${mp.skip ? "" : "checked"}>Импортировать</label>` : ""}</div>
      <label>Вопрос (лицевая сторона)<select data-imp="front" data-g="${gi}">${opts}</select></label>
      <div><p class="small muted" style="margin-bottom:6px">Ответ (оборот): можно выбрать несколько полей</p>
      <div class="fieldmap">${g.fieldNames.map((n, i) => i === mp.front ? "" : `<label class="check small"><input type="checkbox" data-imp="back" data-g="${gi}" data-i="${i}" ${mp.back.includes(i) ? "checked" : ""}>${esc(n)}</label>`).join("")}</div></div>
      <div class="sample">${sample.map(n => {
        let f = n.fields[mp.front] || "", b = mp.back.map(i => n.fields[i] || "").filter(Boolean).join("\n");
        if (S.hasCloze(f)) { b = [S.clozeBack(f), b].filter(Boolean).join("\n"); f = S.clozeFront(f); }
        return `<div><span>${esc(f) || '<i class="muted">пусто</i>'}</span><span class="muted">${esc(b) || "пусто"}</span></div>`;
      }).join("")}</div></div>`;
  });
  html += `<div class="panel">
    ${imp.scheduled ? `<label class="check"><input type="checkbox" data-imp="sched" ${imp.keepSched ? "checked" : ""}>Сохранить прогресс из Anki (${imp.scheduled} ${plural(imp.scheduled, "карточка", "карточки", "карточек")} уже изучались)</label>` : ""}
    ${imp.kind === "anki" && deckNames.size > 1 ? `<label class="check"><input type="checkbox" data-imp="merge" ${imp.merge ? "checked" : ""}>Собрать всё в одну колоду</label>` : ""}
    ${imp.kind === "text" || imp.merge || deckNames.size <= 1 ? `<label>Название колоды<input data-imp="name" id="imp-name" value="${esc(imp.customName ?? (imp.kind === "anki" && !imp.merge && deckNames.size === 1 ? [...deckNames][0] : imp.mergeName))}" maxlength="80"></label>` : ""}
    <p class="muted small">Если колода с таким названием уже есть, новые карточки добавятся в неё, а повторы будут пропущены. Размер колоды не ограничен: большие колоды сохраняются частями, и это может занять до минуты.</p>
    <div class="row"><button class="btn" data-act="do-import">Импортировать</button><button class="btn ghost" data-act="imp-reset">Выбрать другой файл</button></div></div>`;
  return html;
}
function renderImport() {
  const imp = state.imp;
  let html = `<div class="row"><button class="chip" data-act="home">← Колоды</button></div>`;
  if (!imp || imp.status === "error") {
    html += `<h1>Импорт файла</h1>${imp && imp.error ? `<p class="notice warn">${esc(imp.error)}</p>` : ""}
    <label class="drop" id="drop" for="imp-file"><input type="file" id="imp-file">
      <h2>Выберите файл или перетащите его сюда</h2>
      <div class="formats"><span>.apkg</span><span>.colpkg</span><span>.txt</span><span>.csv</span><span>.tsv</span><span>.json</span></div>
      <span class="btn">Выбрать файл</span></label>
    <div class="panel"><h3>Откуда взять файл</h3>
      <p class="small"><b>Anki на компьютере:</b> «Файл → Экспорт», формат «Пакет колод Anki (.apkg)». Чтобы перенести прогресс, отметьте «Включить данные о расписании».</p>
      <p class="small"><b>Готовые колоды:</b> скачайте .apkg с ankiweb.net/shared/decks, это бесплатно.</p>
      <p class="small"><b>Quizlet:</b> в наборе «… → Экспорт», скопируйте текст в файл .txt или вставьте прямо в новую колоду.</p>
      <p class="small"><b>Резервная копия Словника (.json):</b> переносит колоды вместе с прогрессом, например со старой версии на новую.</p>
      <p class="small"><b>Таблица Excel или Google:</b> сохраните как .csv. Первая колонка — слово, вторая — перевод.</p></div>`;
  } else if (imp.status === "loading") {
    html += `<div class="panel done"><div class="spinner" aria-hidden="true"></div><p id="imp-step">${esc(imp.step)}</p></div>`;
  } else if (imp.status === "backup") {
    const b = imp.backup, nd = Object.keys((b.stats && b.stats.days) || {}).length;
    const same = b.decks.filter(d => d && state.decks[d.id]).length;
    html += `<div class="panel"><h1>Резервная копия</h1>
      <p>${b.exported ? "Создана " + new Date(b.exported).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) + ". " : ""}Внутри ${b.decks.length} ${plural(b.decks.length, "колода", "колоды", "колод")}, ${imp.cards} ${plural(imp.cards, "карточка", "карточки", "карточек")} и статистика за ${nd} ${plural(nd, "день", "дня", "дней")}.</p>
      ${same ? `<p class="notice small">${same} ${plural(same, "колода уже есть", "колоды уже есть", "колод уже есть")} здесь. Они заменятся версией из копии.</p>` : ""}
      <div class="row"><button class="btn" data-act="do-restore">Восстановить</button><button class="btn ghost" data-act="imp-reset">Выбрать другой файл</button></div></div>`;
  } else html += importPreviewHtml(imp);
  app.innerHTML = html;
  const input = document.getElementById("imp-file"), drop = document.getElementById("drop");
  if (input) {
    input.addEventListener("change", () => { if (input.files[0]) handleFile(input.files[0]); });
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
  }
}
app.addEventListener("change", e => {
  const t = e.target, kind = t.dataset && t.dataset.imp; if (!kind || !state.imp) return;
  const imp = state.imp, gi = +t.dataset.g, mp = imp.maps[gi];
  if (kind === "front") { mp.front = +t.value; mp.back = mp.back.filter(i => i !== mp.front); if (!mp.back.length) { const o = imp.groups[gi].fieldNames.findIndex((_, i) => i !== mp.front); if (o >= 0) mp.back = [o]; } }
  else if (kind === "back") { const i = +t.dataset.i; mp.back = t.checked ? [...mp.back, i].sort((a, b) => a - b) : mp.back.filter(x => x !== i); }
  else if (kind === "skip") mp.skip = !t.checked;
  else if (kind === "sched") imp.keepSched = t.checked;
  else if (kind === "merge") imp.merge = t.checked;
  else if (kind === "name") { imp.customName = t.value; return; }
  render();
});
function doImport() {
  const imp = state.imp; if (!imp) return;
  const nameEl = document.getElementById("imp-name");
  if (nameEl && nameEl.value.trim()) imp.mergeName = nameEl.value.trim();
  const deckNames = new Set(); imp.groups.forEach(g => g.notes.forEach(n => deckNames.add(n.deck)));
  const singleName = imp.kind === "text" || imp.merge || deckNames.size <= 1;
  const res = S.buildImport(imp.groups, imp.maps, { keepSched: imp.keepSched, crt: imp.crt, mergeName: singleName ? imp.mergeName : "", defaultName: imp.mergeName }, deckList());
  let deckCount = 0;
  for (const d of res.decks) {
    if (d.target && state.decks[d.target.id]) { const live = state.decks[d.target.id]; live.cards.push(...d.cards); saveDeck(live); }
    else createDeck(d.name, d.cards);
    deckCount++;
  }
  state.imp = null;
  state.flash = { until: Date.now() + 15000, text: "" };
  state.flash.text = res.added ? `Импортировано ${res.added} ${plural(res.added, "карточка", "карточки", "карточек")} в ${deckCount} ${plural(deckCount, "колоду", "колоды", "колод")}${res.dupes ? `, пропущено повторов: ${res.dupes}` : ""}.`
    : `Новых карточек нет${res.dupes ? `: все ${res.dupes} уже есть в ваших колодах` : ". Проверьте, что выбраны поля для вопроса и ответа"}.`;
  go({ name: "home" });
}

/* ---------- study ---------- */
function renderStudy() {
  const deck = state.decks[state.view.deck], now = Date.now();
  const locked = state.view.lock && deck.cards.find(x => x.id === state.view.lock);
  const card = locked || nextCard(deck, now), c = counts(deck, now);
  if (!card) {
    const nd = nextLearnDue(deck), td = todayStats();
    app.innerHTML = `<div class="row"><button class="chip" data-act="home">← Колоды</button></div>
      <div class="panel done"><div class="big">На сегодня всё</div>
      <p class="muted">Сегодня ${td.r || 0} ${plural(td.r || 0, "ответ", "ответа", "ответов")}. ${nd ? `Следующая карточка на изучении появится в ${new Date(nd).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}.` : "Повторения уже запланированы на следующие дни."}</p>
      <div class="row" style="justify-content:center">${deck.cards.length >= 4 ? `<button class="btn ghost" data-act="quick-test" data-id="${deck.id}">Пройти тест</button>` : ""}<button class="btn ghost" data-act="deck" data-id="${deck.id}">Добавить слова</button><button class="btn" data-act="home">К колодам</button></div></div>`;
    state.view.card = null; return;
  }
  if (state.view.card !== card.id) { state.view.card = card.id; state.view.typed = null; }
  state.view.lock = card.id;
  const q = deck.reverse ? card.b : card.f, a = deck.reverse ? card.f : card.b;
  const shown = !!state.view.shown;
  const opts = [1, 2, 3, 4].map(r => fmtInterval(schedule(card, r, now, true), now));
  const kind = card.s === 0 ? "c-new" : card.s === 2 ? "c-due" : "c-learn";
  const typed = state.view.typed;
  const verdict = typed != null ? checkAnswer(typed, a) : null;
  app.innerHTML = `<div class="study-top"><button class="chip" data-act="home">← ${esc(deck.name)}</button>
    <div class="row" style="gap:12px">${state.undo && state.undo.deck === deck.id ? `<button class="chip" data-act="undo">Отменить ответ</button>` : ""}<div class="counts"><span class="c-new">${c.n}</span><span class="c-learn">${c.l}</span><span class="c-due">${c.r}</span></div></div></div>
    <div class="scene"><div class="card ${shown ? "flip" : ""}" aria-live="polite">
      <span class="tag ${kind}">${card.s === 0 ? "Новое слово" : card.s === 2 ? "Повторение" : "Изучаю"}</span>
      <div class="face">${esc(q)}</div>
      <button class="speak" data-act="speak" data-text="${esc(card.f)}" aria-label="Произнести слово">${I.speak}</button>
      ${shown ? `<hr>${verdict ? `<div class="typed ${verdict}">${verdict === "wrong" ? "Ваш ответ: " + esc(typed || "—") : verdict === "typo" ? "Почти верно: " + esc(typed) : "Верно!"}</div>` : ""}<div class="back">${esc(a)}</div>` : ""}
    </div></div>
    ${shown ? `<div class="answers">
      <button class="ans a1" data-act="rate" data-r="1">Снова<span>${opts[0]}</span></button>
      <button class="ans a2" data-act="rate" data-r="2">Трудно<span>${opts[1]}</span></button>
      <button class="ans a3" data-act="rate" data-r="3">Хорошо<span>${opts[2]}</span></button>
      <button class="ans a4" data-act="rate" data-r="4">Легко<span>${opts[3]}</span></button></div>
      <p class="kbd">Клавиши 1–4 для ответа${verdict === "wrong" ? ". Совет: при ошибке нажмите «Снова»" : ""}</p>`
    : deck.typeIn ? `<form id="type-form" class="row" style="flex-wrap:nowrap"><input id="type-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Ваш ответ" style="flex:1;min-width:0"><button class="btn" type="submit">Проверить</button></form><p class="kbd">Enter — проверить</p>`
    : `<button class="btn show" data-act="show">Показать ответ</button><p class="kbd">Пробел — показать ответ</p>`}`;
  const form = document.getElementById("type-form");
  if (form) {
    const inp = document.getElementById("type-in"); inp.focus();
    form.addEventListener("submit", e => { e.preventDefault(); state.view.typed = inp.value; state.view.shown = true; render(); });
  }
}
function rate(r) {
  const deck = state.decks[state.view.deck]; if (!deck) return;
  const idx = deck.cards.findIndex(c => c.id === state.view.card); if (idx < 0) return;
  const old = deck.cards[idx], now = Date.now();
  state.undo = { deck: deck.id, idx, card: old, newDay: deck.newDay, newDone: deck.newDone, stats: JSON.stringify(state.stats) };
  const wasNew = old.s === 0;
  if (wasNew) { const tk = dayKey(now); if (deck.newDay !== tk) { deck.newDay = tk; deck.newDone = 0; } deck.newDone++; }
  deck.cards[idx] = schedule(old, r, now, false);
  S.bump(state.stats, now, { r: 1, n: wasNew ? 1 : 0, rv: old.s === 2 ? 1 : 0, ok: old.s === 2 && r > 1 ? 1 : 0 });
  saveDeck(deck); saveStats();
  state.view.shown = false; state.view.typed = null; state.view.lock = null; render();
}
function undo() {
  const u = state.undo, deck = u && state.decks[u.deck]; if (!deck) return;
  deck.cards[u.idx] = u.card; deck.newDay = u.newDay; deck.newDone = u.newDone;
  state.stats = JSON.parse(u.stats); state.undo = null;
  saveDeck(deck); saveStats();
  state.view.card = u.card.id; state.view.lock = u.card.id; state.view.shown = false; state.view.typed = null;
  render();
}

/* ---------- tests ---------- */
const MODES = [
  { id: "choice", name: "Выбор ответа", desc: "Четыре варианта, один верный", icon: I.choice, min: 4 },
  { id: "type", name: "Написать перевод", desc: "Проверка с учётом опечаток", icon: I.type, min: 1 },
  { id: "pairs", name: "Найди пары", desc: "Соедините слова с переводами на время", icon: I.pairs, min: 3 }
];
function renderTestSetup() {
  const decks = deckList();
  const cfg = state.testCfg || (state.testCfg = { deck: "all", mode: "choice", dir: "fwd", count: 10 });
  if (cfg.deck !== "all" && !state.decks[cfg.deck]) cfg.deck = "all";
  const pool = cfg.deck === "all" ? decks.flatMap(d => d.cards) : state.decks[cfg.deck].cards;
  const mode = MODES.find(m => m.id === cfg.mode);
  if (!decks.length) { app.innerHTML = `<h1>Тесты</h1><div class="empty"><p class="muted">Сначала создайте или импортируйте колоду: тесты строятся из ваших слов.</p><div class="row"><button class="btn" data-act="import">Импорт файла</button><button class="btn ghost" data-act="sample">Пример колоды</button></div></div>`; return; }
  app.innerHTML = `<h1>Тесты</h1>
  <p class="muted">Быстрая проверка без влияния на расписание повторений. Слова с ошибками можно сразу отправить на повторение.</p>
  <div class="modes">${MODES.map(m => `<button class="mode" data-act="t-mode" data-id="${m.id}" aria-pressed="${m.id === cfg.mode}">${m.icon}<b>${m.name}</b><span>${m.desc}</span></button>`).join("")}</div>
  <div class="panel">
    <label>Колода<select id="t-deck"><option value="all">Все колоды</option>${decks.map(d => `<option value="${d.id}" ${cfg.deck === d.id ? "selected" : ""}>${esc(d.name)} (${d.cards.length})</option>`).join("")}</select></label>
    <div class="row"><span class="small muted">Направление:</span><button class="chip ${cfg.dir === "fwd" ? "on" : ""}" data-act="t-dir" data-id="fwd">Слово → перевод</button><button class="chip ${cfg.dir === "rev" ? "on" : ""}" data-act="t-dir" data-id="rev">Перевод → слово</button></div>
    <div class="row"><span class="small muted">Вопросов:</span>${[10, 20, 30].map(n => `<button class="chip ${cfg.count === n ? "on" : ""}" data-act="t-count" data-id="${n}">${n}</button>`).join("")}</div>
    ${pool.length < mode.min ? `<p class="notice warn small">Для этого режима нужно хотя бы ${mode.min} ${plural(mode.min, "карточка", "карточки", "карточек")} в колоде.</p>` : ""}
    <button class="btn" data-act="t-start" ${pool.length < mode.min ? "disabled" : ""}>Начать тест</button>
  </div>`;
  document.getElementById("t-deck").addEventListener("change", e => { cfg.deck = e.target.value; render(); });
}
function startTest() {
  const cfg = state.testCfg, decks = deckList();
  const pool = (cfg.deck === "all" ? decks.flatMap(d => d.cards.map(c => ({ c, d: d.id }))) : state.decks[cfg.deck].cards.map(c => ({ c, d: cfg.deck })));
  const studied = shuffle(pool.filter(x => x.c.s !== 0)), fresh = shuffle(pool.filter(x => x.c.s === 0));
  const picked = [...studied, ...fresh].slice(0, Math.min(cfg.count, pool.length));
  const qa = x => cfg.dir === "fwd" ? { q: x.c.f, a: x.c.b } : { q: x.c.b, a: x.c.f };
  const items = shuffle(picked).map(x => ({ id: x.c.id, deck: x.d, ...qa(x) }));
  const answersPool = [...new Set(pool.map(x => qa(x).a))];
  if (cfg.mode === "choice") items.forEach(it => {
    const wrong = shuffle(answersPool.filter(a => a !== it.a)).slice(0, 3);
    it.options = shuffle([it.a, ...wrong]);
  });
  state.test = { mode: cfg.mode, items, i: 0, results: [], started: Date.now(), picked: null, pairs: null };
  if (cfg.mode === "pairs") nextPairsRound();
  go({ name: "testrun" });
}
function nextPairsRound() {
  const t = state.test, round = t.items.slice(t.i, t.i + 5);
  t.pairs = { left: shuffle(round), right: shuffle(round), done: new Set(), sel: null, err: null };
}
function renderTestRun() {
  const t = state.test, total = t.items.length;
  const progress = `<div class="row between"><button class="chip" data-act="t-quit">← Завершить</button><span class="small muted">${Math.min(t.i + 1, total)} из ${total}</span></div><div class="progress"><i style="width:${(t.results.length / total) * 100}%"></i></div>`;
  if (t.mode === "pairs") {
    const p = t.pairs;
    const cell = (it, side) => `<button class="pair ${p.done.has(it.id) ? "gone" : ""} ${p.sel && p.sel.side === side && p.sel.id === it.id ? "sel" : ""} ${p.err && p.err[side] === it.id ? "err" : ""}" data-act="pair" data-side="${side}" data-id="${it.id}">${esc(side === "l" ? it.q : it.a)}</button>`;
    app.innerHTML = progress + `<p class="muted small">Нажмите слово, затем его перевод.</p><div class="pairs">${p.left.map((it, k) => cell(it, "l") + cell(p.right[k], "r")).join("")}</div>`;
    return;
  }
  const it = t.items[t.i], ans = t.answered;
  let body = `<div class="card" style="min-height:190px"><span class="tag muted">${t.mode === "choice" ? "Выберите перевод" : "Напишите перевод"}</span><div class="face">${esc(it.q)}</div></div>`;
  if (t.mode === "choice") {
    body += `<div class="options">${it.options.map((o, k) => {
      const cls = ans ? (o === it.a ? "right" : o === ans.given ? "wrong" : "") : "";
      return `<button class="opt ${cls}" data-act="t-pick" data-k="${k}" ${ans ? "disabled" : ""}><kbd>${k + 1}</kbd><span>${esc(o)}</span></button>`;
    }).join("")}</div>`;
  } else {
    body += ans ? `<div class="panel" style="background:${ans.ok ? "var(--ok-bg)" : "var(--bad-bg)"}"><b>${ans.verdict === "correct" ? "Верно!" : ans.verdict === "typo" ? "Почти верно, проверьте написание" : "Неверно"}</b>${ans.verdict !== "correct" ? `<p>Правильно: <b>${esc(it.a)}</b></p>` : ""}${ans.verdict === "wrong" && ans.given ? `<p class="small muted">Ваш ответ: ${esc(ans.given)}</p>` : ""}</div>`
      : `<form id="t-form" class="row" style="flex-wrap:nowrap"><input id="t-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Перевод" style="flex:1;min-width:0"><button class="btn" type="submit">Проверить</button></form><button class="chip" data-act="t-dunno" style="align-self:flex-start">Не знаю</button>`;
  }
  if (ans && !(t.mode === "choice" && ans.ok)) body += `<button class="btn" data-act="t-next" id="t-next">${t.i + 1 < total ? "Дальше" : "Результаты"}</button>`;
  app.innerHTML = progress + body;
  const form = document.getElementById("t-form");
  if (form) { const inp = document.getElementById("t-input"); inp.focus(); form.addEventListener("submit", e => { e.preventDefault(); answerTyped(inp.value); }); }
  const nx = document.getElementById("t-next"); if (nx) nx.focus();
}
function record(ok, given) {
  const t = state.test, it = t.items[t.i];
  t.results.push({ id: it.id, deck: it.deck, q: it.q, a: it.a, ok, given });
  S.bump(state.stats, Date.now(), { t: 1, tc: ok ? 1 : 0 });
}
function answerChoice(k) {
  const t = state.test; if (t.answered) return;
  const it = t.items[t.i], given = it.options[k], ok = given === it.a;
  t.answered = { given, ok }; record(ok, given); render();
  if (ok) setTimeout(() => { if (state.test === t && t.answered) testNext(); }, 650);
}
function answerTyped(v) {
  const t = state.test; if (t.answered) return;
  const it = t.items[t.i], verdict = checkAnswer(v, it.a), ok = verdict !== "wrong";
  t.answered = { given: v.trim(), ok, verdict }; record(ok, v.trim()); render();
}
function testNext() {
  const t = state.test; t.answered = null; t.i++;
  if (t.i >= t.items.length) return finishTest();
  render();
}
function pickPair(side, id) {
  const t = state.test, p = t.pairs; if (p.done.has(id)) return;
  p.err = null;
  if (!p.sel || p.sel.side === side) { p.sel = { side, id }; return render(); }
  const l = side === "l" ? id : p.sel.id, r = side === "r" ? id : p.sel.id;
  const li = t.items.find(x => x.id === l), ri = t.items.find(x => x.id === r);
  if (l === r || (li && ri && li.a === ri.a)) {
    p.done.add(l); if (r !== l) p.done.add(r);
    const it = t.items.find(x => x.id === l);
    if (!t.results.some(x => x.id === l)) { t.results.push({ id: l, deck: it.deck, q: it.q, a: it.a, ok: !(p.missed && p.missed.has(l)) }); S.bump(state.stats, Date.now(), { t: 1, tc: p.missed && p.missed.has(l) ? 0 : 1 }); }
    p.sel = null;
    if (p.left.every(x => p.done.has(x.id))) {
      t.i += p.left.length;
      if (t.i >= t.items.length) return finishTest();
      nextPairsRound();
    }
  } else {
    p.missed = p.missed || new Set(); p.missed.add(l);
    p.err = { l, r }; p.sel = null;
    setTimeout(() => { if (state.test === t && t.pairs === p) { p.err = null; render(); } }, 600);
  }
  render();
}
function finishTest() { saveStats(); state.test.ended = Date.now(); go({ name: "testresult" }); }
function renderTestResult() {
  const t = state.test, ok = t.results.filter(r => r.ok).length, n = t.results.length || 1;
  const wrong = t.results.filter(r => !r.ok), secs = Math.round(((t.ended || Date.now()) - t.started) / 1000);
  const pct = Math.round(ok / n * 100);
  app.innerHTML = `<div class="panel done"><span class="score">${pct}%</span>
    <p>${ok} из ${t.results.length} верно · ${Math.floor(secs / 60)} мин ${secs % 60} с</p>
    <p class="muted small">${pct === 100 ? "Без единой ошибки. Отличная работа!" : pct >= 80 ? "Хороший результат. Повторите ошибки, и они закрепятся." : "Ошибки — нормальная часть учёбы. Отправьте их на повторение."}</p></div>
  ${wrong.length ? `<div class="panel"><div class="row between"><h2>Ошибки · ${wrong.length}</h2>${t.sentBack ? `<span class="small muted">Отправлено на повторение</span>` : `<button class="btn" data-act="t-sendback">На повторение сегодня</button>`}</div>
    <div class="mistakes">${wrong.map(r => `<div><span>${esc(r.q)}</span><span><b>${esc(r.a)}</b>${r.given ? `<br><span class="small muted">вы: ${esc(r.given)}</span>` : ""}</span></div>`).join("")}</div></div>` : ""}
  <div class="row"><button class="btn" data-act="t-start">Ещё раз</button><button class="btn ghost" data-act="t-setup">Другой тест</button></div>`;
}
function sendBack() {
  const t = state.test, now = Date.now(), touched = new Set();
  for (const r of t.results.filter(x => !x.ok)) {
    const d = state.decks[r.deck], c = d && d.cards.find(x => x.id === r.id);
    if (!c || c.s === 0) continue;
    if (c.s === 2) c.due = Math.min(c.due, dayStart(now)); else c.due = Math.min(c.due, now);
    touched.add(d.id);
  }
  touched.forEach(id => saveDeck(state.decks[id]));
  t.sentBack = true; render();
}

/* ---------- progress ---------- */
function renderProgress() {
  const now = Date.now(), decks = deckList(), all = decks.flatMap(d => d.cards);
  const learned = all.filter(c => c.s === 2).length, mature = all.filter(c => c.s === 2 && c.ivl >= 21).length;
  const st = S.streak(state.stats, now), days = state.stats.days;
  let rv = 0, ok = 0, active = 0, totalR = 0;
  for (let i = 0; i < 30; i++) { const d = days[dayKey(now - i * DAY)]; if (d) { rv += d.rv || 0; ok += d.ok || 0; if ((d.r || 0) + (d.t || 0)) active++; totalR += d.r || 0; } }
  const weeks = 20, todayStart = dayStart(now), dow = (new Date(todayStart).getDay() + 6) % 7;
  const start = todayStart - (weeks * 7 - 7 + dow) * DAY;
  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const t = start + i * DAY;
    if (t > todayStart) { cells.push(`<i class="future"></i>`); continue; }
    const d = days[dayKey(t + 6 * 3600e3)], v = d ? (d.r || 0) + (d.t || 0) : 0;
    const l = v === 0 ? 0 : v < 10 ? 1 : v < 30 ? 2 : v < 60 ? 3 : 4;
    cells.push(`<i class="l${l}" title="${new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}: ${v}"></i>`);
  }
  const fc = []; for (let i = 0; i < 7; i++) { const s = todayStart + i * DAY, e = s + DAY; fc.push(all.filter(c => (c.s === 2 || (i === 0 && c.s !== 0)) && (i === 0 ? c.due < e : c.due >= s && c.due < e)).length); }
  const mx = Math.max(1, ...fc), wd = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  app.innerHTML = `<h1>Прогресс</h1>
  <div class="tiles">
    <div class="tile"><b>${st}</b><span>${plural(st, "день", "дня", "дней")} подряд</span></div>
    <div class="tile"><b>${all.length}</b><span>всего карточек</span></div>
    <div class="tile"><b>${learned}</b><span>выучено</span></div>
    <div class="tile"><b>${rv ? Math.round(ok / rv * 100) + "%" : "—"}</b><span>помню при повторе, 30 дн.</span></div>
  </div>
  <div class="panel"><div class="row between"><h2>Активность</h2><span class="small muted">${active} ${plural(active, "день", "дня", "дней")} занятий за 30 дней · ${totalR} ${plural(totalR, "ответ", "ответа", "ответов")}</span></div>
    <div class="heat-wrap"><div class="heat">${cells.join("")}</div></div>
    <div class="legend">Меньше <i style="background:var(--heat0)"></i><i style="background:var(--heat1)"></i><i style="background:var(--heat2)"></i><i style="background:var(--heat3)"></i><i style="background:var(--heat4)"></i> Больше</div></div>
  <div class="panel"><h2>Повторения на неделю вперёд</h2>
    <div class="bars">${fc.map((v, i) => `<div class="bar"><b>${v}</b><i style="height:${(v / mx) * 100}%"></i><span>${i === 0 ? "Сег." : wd[(new Date(todayStart + i * DAY).getDay() + 6) % 7]}</span></div>`).join("")}</div>
    <p class="muted small">Зрелых карточек (интервал от 3 недель): ${mature}. Такие слова уже держатся в долговременной памяти.</p></div>
  <div class="panel"><label>Цель дня, ответов<input id="goal" type="number" min="5" max="1000" value="${state.stats.goal || 20}"></label></div>
  <div class="panel"><div class="row between"><div><h3>Резервная копия</h3><p class="muted small">Все колоды с прогрессом в одном файле. Восстановить: «Колоды» → «Импорт файла».</p></div><button class="btn ghost" data-act="backup">Скачать</button></div><p class="small" id="backup-msg" hidden></p></div>
  ${accountPanel()}`;
  document.getElementById("goal").addEventListener("change", e => { state.stats.goal = Math.max(5, Math.min(1000, parseInt(e.target.value, 10) || 20)); saveStats(); });
}

function accountPanel() {
  const C = window.SlovnikCloud; if (!C || !C.enabled) return "";
  const acc = C.account();
  return acc ? `<div class="panel"><div class="row between"><div><h3>Аккаунт</h3><p class="muted small">${esc(acc.email)}</p></div><button class="btn ghost" data-act="sign-out">Выйти</button></div></div>`
    : `<div class="panel"><div class="row between"><div><h3>Аккаунт</h3><p class="muted small">Войдите, чтобы колоды были на всех устройствах.</p></div><button class="btn" data-act="sign-in">Войти</button></div></div>`;
}

/* ---------- events ---------- */
app.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  const handlers = {
    "new": () => go({ name: "new" }), "home": () => go({ name: "home" }),
    "import": () => { if (state.imp && state.imp.status === "error") state.imp = null; go({ name: "import" }); },
    "imp-reset": () => { state.imp = null; render(); }, "do-import": doImport, "do-restore": restoreBackup, "backup": exportBackup,
    "sign-in": () => window.SlovnikCloud.wantLogin(), "sign-out": () => window.SlovnikCloud.signOut(),
    "sample": () => { createDeck("English: базовые слова (пример)", SAMPLE.map(([f, b]) => newCard(f, b))); go({ name: "home" }); },
    "next-quote": () => { state.quoteShift++; render(); },
    "study": () => go({ name: "study", deck: id, shown: false }), "deck": () => go({ name: "deck", deck: id }),
    "show": () => { state.view.shown = true; render(); }, "rate": () => rate(+b.dataset.r), "undo": undo,
    "speak": () => speak(b.dataset.text), "export": exportDeck,
    "edit": () => { state.view.edit = id; render(); window.scrollTo(0, 0); },
    "more-cards": () => { state.view.limit = (state.view.limit || 100) + 100; document.getElementById("cl").innerHTML = cardListHtml(state.decks[state.view.deck], Date.now()); }, "cancel-edit": () => { state.view.edit = null; render(); },
    "del-card": () => { const d = state.decks[state.view.deck]; d.cards = d.cards.filter(c => c.id !== id); saveDeck(d); render(); },
    "ask-del": () => { document.getElementById("del-zone").innerHTML = `<span>Удалить колоду и весь прогресс по ней?</span><button class="btn danger" data-act="del-deck">Да, удалить</button><button class="btn ghost" data-act="cancel-del">Отмена</button>`; },
    "cancel-del": render,
    "del-deck": () => { const d = state.view.deck; delete state.decks[d]; state.store.remove(d); go({ name: "home" }); },
    "quick-test": () => { state.testCfg = { ...(state.testCfg || { mode: "choice", dir: "fwd", count: 10 }), deck: id }; go({ name: "tests" }); },
    "t-mode": () => { state.testCfg.mode = id; render(); }, "t-dir": () => { state.testCfg.dir = id; render(); },
    "t-count": () => { state.testCfg.count = +id; render(); }, "t-start": startTest, "t-setup": () => go({ name: "tests" }),
    "t-quit": () => { if (state.test.results.length) finishTest(); else go({ name: "tests" }); },
    "t-pick": () => answerChoice(+b.dataset.k), "t-next": testNext, "t-dunno": () => answerTyped(""),
    "pair": () => pickPair(b.dataset.side, id), "t-sendback": sendBack
  };
  if (handlers[act]) handlers[act]();
});
document.addEventListener("keydown", e => {
  if (e.target.closest && e.target.closest("input,textarea,select")) return;
  const v = state.view;
  if (v.name === "study") {
    const deck = state.decks[v.deck];
    if (!v.shown && !(deck && deck.typeIn) && (e.code === "Space" || e.key === "Enter")) { e.preventDefault(); v.shown = true; render(); }
    else if (v.shown && ["1", "2", "3", "4"].includes(e.key)) rate(+e.key);
    else if (v.shown && e.code === "Space") { e.preventDefault(); rate(3); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "z" && state.undo) { e.preventDefault(); undo(); }
  } else if (v.name === "testrun" && state.test && state.test.mode === "choice" && !state.test.answered && ["1", "2", "3", "4"].includes(e.key)) answerChoice(+e.key - 1);
});
setInterval(() => { if (state.view.name === "home" || (state.view.name === "study" && !state.view.card)) render(); }, 30000);

/* ---------- boot ---------- */
const QUIET_VIEWS = new Set(["study", "testrun", "import", "new"]);
function onDecks(decks, fromCache) {
  state.decks = decks; state.ready = true;
  if (state.store.kind === "db" && !fromCache && !/Сохран|несохран/.test(syncEl.textContent)) setSync("Синхронизировано");
  if (QUIET_VIEWS.has(state.view.name) && state.view.name !== "study") return;
  if (state.view.name === "study" && state.view.shown) return;
  if (state.view.name === "deck" && document.activeElement && document.activeElement.closest("input,textarea,select")) return;
  render();
}
function onStats(st) { state.stats = st; if (state.ready && (state.view.name === "home" || state.view.name === "progress") && !(document.activeElement && document.activeElement.id === "goal")) render(); }
async function boot() {
  let store = null;
  try {
    if (window.SlovnikCloud) {
      const s = await window.SlovnikCloud.start(app);
      if (s) store = makeDbStore(s.db, s.userId);
    } else if (window.claude && window.claude.use) {
      const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
      const id = user ? await user.id() : null;
      if (db && id) store = makeDbStore(db, id);
    }
  } catch {}
  if (!store) { store = makeLocalStore(); setSync("Сохраняется в этом браузере"); }
  else if (window.SlovnikCloud) setSync("Загружаю…");
  state.store = store;
  store.start(onDecks, onStats,
    () => setSync(state.ready ? "Нет связи, данные могут быть устаревшими" : "Не удаётся загрузить колоды, проверьте интернет"),
    () => setSync("Синхронизация остановилась, обновите страницу"));
}
boot();
})();
