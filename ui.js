(() => {
"use strict";
const S = window.Slovnik;
const { DAY, dayStart, dayKey, shuffle, serialize, deserialize, newCard, schedule, fmtInterval, counts, nextCard, nextLearnDue, checkAnswer } = S;

const state = { decks: {}, stats: { goal: 20, days: {} }, view: { name: "home" }, store: null, ready: false, flash: null, undo: null, imp: null, test: null, quoteShift: 0 };
const app = document.getElementById("app"), syncEl = document.getElementById("sync"), tabs = document.getElementById("tabs");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const setSync = t => { syncEl.textContent = t; };
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many; };
const PREFS_KEY = "slovnik-prefs";
const prefs = (() => { try { return { arFont: "naskh", arSize: "l", arKb: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") }; } catch { return { arFont: "naskh", arSize: "l", arKb: false }; } })();
const AR_FONTS = { naskh: ["Noto Naskh Arabic", "Насх: чёткий, для чтения"], amiri: ["Amiri", "Амири: классический, как в книгах"], sch: ["Scheherazade New", "Шахерезада: крупные огласовки"] };
const AR_SIZES = { m: [1.15, "Обычный"], l: [1.35, "Крупный"], xl: [1.6, "Очень крупный"] };
function applyPrefs() {
  const r = document.documentElement.style;
  r.setProperty("--f-ar", `"${(AR_FONTS[prefs.arFont] || AR_FONTS.naskh)[0]}","Noto Naskh Arabic","Geeza Pro","Arabic Typesetting","Segoe UI",serif`);
  r.setProperty("--ar-scale", String((AR_SIZES[prefs.arSize] || AR_SIZES.l)[0]));
}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} applyPrefs(); }
applyPrefs();
const arWrap = html => html.replace(S.AR_RUN, m => `<span class="ar" lang="ar" dir="rtl">${m}</span>`);
function T(text, deck, where) {
  let t = String(text ?? "");
  if (deck && S.hasArabic(t)) {
    const h = S.deckOpts(deck).harakat;
    if (h === "hide" && where !== "word" || h === "q" && where === "q") t = S.stripHarakat(t);
  }
  return arWrap(esc(t));
}
function translitHtml(text, deck) {
  if (!deck || deck.lang !== "ar" || S.deckOpts(deck).translit === false) return "";
  const tr = S.translitArabic(text);
  return tr && tr !== text ? `<div class="translit">${esc(tr)}</div>` : "";
}
const AR_KEYS = [
  ["ض", "ص", "ث", "ق", "ف", "غ", "ع", "ه", "خ", "ح", "ج", "د"],
  ["ش", "س", "ي", "ب", "ل", "ا", "ت", "ن", "م", "ك", "ط", "ذ"],
  ["ء", "أ", "إ", "آ", "ؤ", "ئ", "ر", "ى", "ة", "و", "ز", "ظ"],
  ["\u064E", "\u064B", "\u064F", "\u064C", "\u0650", "\u064D", "\u0652", "\u0651", "ـ", "،", "؟", "⌫"]
];
const KEY_LABEL = { "\u064E": "◌َ", "\u064B": "◌ً", "\u064F": "◌ُ", "\u064C": "◌ٌ", "\u0650": "◌ِ", "\u064D": "◌ٍ", "\u0652": "◌ْ", "\u0651": "◌ّ" };
const KEY_NAME = { "\u064E": "фатха", "\u064B": "фатхатан", "\u064F": "дамма", "\u064C": "дамматан", "\u0650": "касра", "\u064D": "касратан", "\u0652": "сукун", "\u0651": "шадда", "⌫": "стереть" };
function arKeyboardHtml(target) {
  return `<div class="arkb" dir="rtl" data-target="${target}" role="group" aria-label="Арабская клавиатура">${AR_KEYS.map(row => `<div class="arkb-row">${row.map(k => `<button type="button" class="arkb-key ${KEY_LABEL[k] ? "mark" : ""} ${k === "⌫" ? "wide" : ""}" data-act="ak" data-k="${k}" ${KEY_NAME[k] ? `aria-label="${KEY_NAME[k]}"` : ""}>${KEY_LABEL[k] || k}</button>`).join("")}</div>`).join("")}
    <div class="arkb-row"><button type="button" class="arkb-key space" data-act="ak" data-k=" " aria-label="пробел">пробел</button></div></div>`;
}
function kbToggleHtml(expected, target) {
  if (!S.hasArabic(expected)) return "";
  return `<div class="row" style="gap:8px"><button type="button" class="chip ${prefs.arKb ? "on" : ""}" data-act="ak-toggle">⌨ Арабская клавиатура на экране</button></div>${prefs.arKb ? arKeyboardHtml(target) : ""}`;
}
function typeKey(target, k) {
  const el = document.getElementById(target); if (!el) return;
  const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? el.value.length;
  if (k === "⌫") { const from = a === b ? Math.max(0, a - 1) : a; el.value = el.value.slice(0, from) + el.value.slice(b); el.setSelectionRange(from, from); }
  else { el.value = el.value.slice(0, a) + k + el.value.slice(b); el.setSelectionRange(a + k.length, a + k.length); }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const hue = s => { let h = 0; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 360; return h; };

/* ---------- storage ---------- */
function makeLocalStore() {
  const KEY = "slovnik-decks", SKEY = "slovnik-stats";
  const lsRead = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") || d; } catch { return d; } };
  const lsWrite = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  let idb = null;
  const openIdb = () => new Promise(res => {
    try {
      const rq = indexedDB.open("slovnik", 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore("decks"); rq.result.createObjectStore("meta"); };
      rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); rq.onblocked = () => res(null);
    } catch { res(null); }
  });
  const tx = (store, mode, fn) => new Promise((res, rej) => {
    const t = idb.transaction(store, mode), st = t.objectStore(store); const out = fn(st);
    t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
  const failed = e => { state.storageError = e && e.name === "QuotaExceededError" ? "В браузере закончилось место для данных." : "Браузер не дал сохранить данные."; setSync("Не сохранено"); render(); };
  const ok = () => { if (state.storageError) { state.storageError = null; render(); } setSync("Сохранено на этом устройстве"); };
  const JKEY = "slovnik-journal";
  let chain = Promise.resolve(), seq = 0;
  const queue = (id, v) => {
    const n = ++seq;
    if (!idb) {
      const all = lsRead(KEY, {}); if (v) all[id] = v; else delete all[id];
      return lsWrite(KEY, all) ? ok() : failed({ name: "QuotaExceededError" });
    }
    const journal = lsRead(JKEY, {}); journal[id] = { v, n }; lsWrite(JKEY, journal);
    chain = chain.then(() => tx("decks", "readwrite", st => { if (v) st.put(v, id); else st.delete(id); }))
      .then(() => { const j = lsRead(JKEY, {}); if (j[id] && j[id].n === n) { delete j[id]; if (Object.keys(j).length) lsWrite(JKEY, j); else { try { localStorage.removeItem(JKEY); } catch {} } } ok(); })
      .catch(failed);
  };
  return {
    kind: "local",
    get engine() { return idb ? "IndexedDB" : "localStorage"; },
    async start(onDecks, onStats) {
      idb = await openIdb();
      let raw = {}, stats = null;
      if (idb) {
        try {
          const keys = await tx("decks", "readonly", st => st.getAllKeys());
          const vals = await tx("decks", "readonly", st => st.getAll());
          (keys || []).forEach((k, i) => { raw[k] = vals[i]; });
          stats = lsRead(SKEY, null) || await tx("meta", "readonly", st => st.get("stats"));
          const journal = lsRead(JKEY, null);
          if (journal) {
            for (const [id, e] of Object.entries(journal)) { if (e.v) raw[id] = e.v; else delete raw[id]; }
            await tx("decks", "readwrite", st => { for (const [id, e] of Object.entries(journal)) { if (e.v) st.put(e.v, id); else st.delete(id); } });
            try { localStorage.removeItem(JKEY); } catch {}
          }
          const legacy = lsRead(KEY, null);
          if (legacy && Object.keys(legacy).length) {
            for (const [id, v] of Object.entries(legacy)) if (!raw[id]) raw[id] = v;
            await tx("decks", "readwrite", st => { for (const [id, v] of Object.entries(legacy)) st.put(raw[id], id); });
            try { localStorage.removeItem(KEY); } catch {}
          }
        } catch { idb = null; }
      }
      if (!idb) { raw = lsRead(KEY, {}); stats = lsRead(SKEY, null); }
      try { if (navigator.storage && navigator.storage.persist) state.persisted = await navigator.storage.persist(); } catch {}
      const out = {};
      for (const [id, v] of Object.entries(raw)) if (v) out[id] = v.cards && v.cards[0] && Array.isArray(v.cards[0]) ? deserialize(id, v) : deserialize(id, serialize(v));
      onDecks(out, false); onStats(stats || { goal: 20, days: {} });
    },
    save(deck) { queue(deck.id, serialize(deck)); },
    remove(id) { queue(id, null); },
    saveStats(st) {
      if (!lsWrite(SKEY, st) && !idb) failed({ name: "QuotaExceededError" });
      if (idb) tx("meta", "readwrite", s2 => s2.put(st, "stats")).catch(() => {});
    }
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
  function enqueue(path, entry) { queue.delete(path); queue.set(path, entry); kick(250); }
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
  const deck = { id: S.uid(), name, created: Date.now(), newPerDay: S.DEFAULT_NEW_PER_DAY, reverse: false, typeIn: false, newDay: "", newDone: 0, revDay: "", revDone: 0, lang: guessLang(cards), opts: {}, cards };
  saveDeck(deck); return deck;
}
const deckList = () => Object.values(state.decks).sort((a, b) => a.created - b.created);
function guessLang(cards) {
  const arab = cards.slice(0, 60).filter(c => S.hasArabic(c.f) || S.hasArabic(c.b)).length;
  if (arab && arab >= Math.min(cards.length, 60) / 2) return "ar";
  const sample = cards.slice(0, 40).map(c => c.f).join(" ").toLowerCase();
  if (/[äöüß]/.test(sample) || /\b(der|die|das|und|nicht)\b/.test(sample)) return "de";
  if (/\b(de|het|een|niet|ij)\b|ij/.test(sample) && !/\b(the|to)\b/.test(sample)) return "nl";
  if (/[ñ¿¡]/.test(sample) || /\b(el|los|las|una)\b/.test(sample)) return "es";
  if (/[àâçèêëîïôûùœ]/.test(sample) || /\b(le|la|les|une|est)\b/.test(sample)) return "fr";
  return "en";
}

/* ---------- speech ---------- */
const TTS = { ar: "ar-SA", en: "en-US", nl: "nl-NL", de: "de-DE", fr: "fr-FR", es: "es-ES", it: "it-IT", pt: "pt-PT", sv: "sv-SE", pl: "pl-PL", tr: "tr-TR" };
function speak(text, lang) {
  try {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    if (S.hasArabic(text)) {
      const runs = String(text).match(S.AR_RUN) || []; text = runs.join("، ") || text; lang = "ar";
      const voices = speechSynthesis.getVoices();
      if (voices.length && !voices.some(v => /^ar/i.test(v.lang))) {
        state.flash = { until: Date.now() + 9000, text: "В системе нет арабского голоса. На iPhone: Настройки → Универсальный доступ → Устный контент → Голоса → Арабский." };
      }
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang && TTS[lang] && !/[а-яё]/i.test(text) ? TTS[lang] : /[а-яё]/i.test(text) ? "ru-RU" : /[äöüß]/i.test(text) ? "de-DE" : /[ñ¿¡]/i.test(text) ? "es-ES" : /[àâçéèêëîïôûùœ]/i.test(text) ? "fr-FR" : /[぀-ヿ]/.test(text) ? "ja-JP" : /[一-鿿]/.test(text) ? "zh-CN" : /[가-힯]/.test(text) ? "ko-KR" : "en-US";
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
const SAMPLE_AR = [["كِتَابٌ", "книга"], ["قَلَمٌ", "ручка, карандаш"], ["بَيْتٌ", "дом"], ["بَابٌ", "дверь"], ["مَدْرَسَةٌ", "школа"], ["مُعَلِّمٌ", "учитель"], ["طَالِبٌ", "студент, ученик"], ["مَاءٌ", "вода"], ["شَمْسٌ", "солнце"], ["قَمَرٌ", "луна"], ["يَوْمٌ", "день"], ["لَيْلٌ", "ночь"], ["كَبِيرٌ", "большой"], ["صَغِيرٌ", "маленький"], ["جَمِيلٌ", "красивый"], ["كَتَبَ", "писать (он написал)"], ["قَرَأَ", "читать (он прочитал)"], ["ذَهَبَ", "идти, уходить (он пошёл)"], ["جَلَسَ", "сидеть, садиться (он сел)"], ["فَهِمَ", "понимать (он понял)"]];
const SAMPLE = [["apple","яблоко"],["to borrow","брать взаймы"],["to lend","давать взаймы"],["although","хотя"],["to achieve","достигать"],["reliable","надёжный"],["to improve","улучшать"],["opportunity","возможность"],["to suggest","предлагать"],["enough","достаточно"],["to own","владеть"],["weather","погода"],["to remember","помнить"],["to forget","забывать"],["neighbour","сосед"],["to explain","объяснять"],["purpose","цель, назначение"],["to require","требовать"],["obvious","очевидный"],["to avoid","избегать"]];

/* ---------- navigation ---------- */
const TAB_OF = { home: "home", deck: "home", new: "home", import: "home", dict: "dict", word: "dict", tests: "tests", testresult: "tests", progress: "progress" };
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
  if (v.name === "dict") return renderDict();
  if (v.name === "word" && state.decks[v.deck] && state.decks[v.deck].cards.some(c => c.id === v.card)) return renderWord();
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
  if (state.storageError) html += `<p class="notice warn"><b>Изменения не сохраняются.</b> ${esc(state.storageError)} Скачайте резервную копию на вкладке «Прогресс», чтобы не потерять прогресс.</p>`;
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
      <div class="row"><button class="btn" data-act="import">Импортировать файл</button><button class="btn ghost" data-act="new">Создать колоду</button><button class="btn ghost" data-act="sample-ar">Пример: 20 арабских слов</button><button class="btn ghost" data-act="sample">Пример: 20 английских слов</button></div></div>`;
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
    <label>Слова (можно добавить позже)<textarea dir="auto" id="nd-words" placeholder="apple — яблоко&#10;to borrow — брать взаймы&#10;reliable; надёжный"></textarea></label>
    <p class="muted small">Одна пара на строку. Разделитель: тире, точка с запятой, «=» или табуляция. Арабский можно вставлять с огласовками. Для файлов есть <button type="button" class="chip" data-act="import">импорт</button>, а для знакомства <button type="button" class="chip" data-act="sample-ar">пример арабской колоды</button>.</p>
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
      <label style="flex:1;min-width:150px">Язык слов<select id="dk-lang">${Object.entries(S.LANG_RU).map(([k, v]) => `<option value="${k}" ${deck.lang === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label style="flex:1;min-width:170px">Как отвечать<select id="dk-type"><option value="0" ${deck.typeIn ? "" : "selected"}>Вспомнить и проверить себя</option><option value="1" ${deck.typeIn ? "selected" : ""}>Вписать ответ</option></select></label>
    </div>
    ${deckProgressHtml(deck, now)}
  </div>
  ${optionsHtml(deck)}
  <form class="panel" id="addform"><h2>${editing ? "Изменить карточку" : "Добавить карточки"}</h2>
    ${editing ? `<label>Слово<textarea dir="auto" id="ed-f" style="min-height:60px">${esc(editing.f)}</textarea></label><label>Перевод<textarea dir="auto" id="ed-b" style="min-height:60px">${esc(editing.b)}</textarea></label><div class="row"><button class="btn" type="submit">Сохранить</button><button class="btn ghost" type="button" data-act="cancel-edit">Отмена</button></div>`
      : `<textarea dir="auto" id="add-words" placeholder="слово — перевод&#10;по одной паре на строку"></textarea><div class="row"><button class="btn" type="submit">Добавить</button><span class="muted small" id="add-count"></span></div>`}
  </form>
  <div class="panel">
    <div class="row between"><h2>Карточки · ${deck.cards.length}</h2>${deck.cards.length > 20 ? `<input dir="auto" id="cl-q" type="search" placeholder="Найти слово" value="${esc(state.view.q || "")}" style="max-width:220px">` : ""}</div>
    <div id="cl">${cardListHtml(deck, now)}</div>
  </div>
  <div class="panel"><div class="row between"><div><h3>Экспорт</h3><p class="muted small">Текстовый файл, который открывается в Anki через «Файл → Импорт».</p></div><button class="btn ghost" data-act="export" ${deck.cards.length ? "" : "disabled"}>Скачать .txt</button></div><p class="small" id="export-msg" hidden></p></div>
  <div class="panel"><div class="row" id="del-zone"><button class="btn danger" data-act="ask-del">Удалить колоду</button></div></div>`;
  const qI = document.getElementById("cl-q");
  if (qI) qI.addEventListener("input", () => { state.view.q = qI.value; state.view.limit = 100; document.getElementById("cl").innerHTML = cardListHtml(deck, Date.now()); });
  const nameI = document.getElementById("dk-name");
  nameI.addEventListener("change", () => { const n = nameI.value.trim(); if (n) { deck.name = n; saveDeck(deck); } });
  document.getElementById("dk-new").addEventListener("change", e => { deck.newPerDay = Math.max(0, Math.min(9999, parseInt(e.target.value, 10) || 0)); saveDeck(deck); });
  document.getElementById("dk-lang").addEventListener("change", e => { deck.lang = e.target.value; saveDeck(deck); render(); });
  document.getElementById("dk-opts").addEventListener("toggle", e => { state.optsOpen = e.target.open; });
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
function deckProgressHtml(deck, now) {
  const st = { new: 0, learn: 0, review: 0, known: 0, sus: 0 }; let hard = 0;
  for (const c of deck.cards) { st[S.wordStatus(c)]++; if (S.isHard(c)) hard++; }
  const total = deck.cards.length || 1, pct = k => (st[k] / total * 100).toFixed(2);
  return `<div class="stackbar" role="img" aria-label="Знаю ${st.known}, повторяю ${st.review}, изучаю ${st.learn}, новых ${st.new}"><i class="sb-known" style="width:${pct("known")}%"></i><i class="sb-review" style="width:${pct("review")}%"></i><i class="sb-learn" style="width:${pct("learn")}%"></i></div>
    <div class="legend-row small"><span><i class="dot sb-known"></i>Знаю ${st.known}</span><span><i class="dot sb-review"></i>Повторяю ${st.review}</span><span><i class="dot sb-learn"></i>Изучаю ${st.learn}</span><span><i class="dot sb-new"></i>Новых ${st.new}</span>${hard ? `<span>Трудных ${hard}</span>` : ""}${st.sus ? `<span>Приостановлено ${st.sus}</span>` : ""}</div>`;
}
const sel = (key, val, list) => `<select data-opt="${key}">${list.map(([v, t]) => `<option value="${v}" ${String(val) === String(v) ? "selected" : ""}>${t}</option>`).join("")}</select>`;
function optionsHtml(deck) {
  const o = S.deckOpts(deck);
  return `<details class="panel opts" id="dk-opts" ${state.optsOpen ? "open" : ""}><summary><span><b>Параметры изучения</b><br><span class="muted small">Порядок слов, лимиты, шаги, алгоритм: ${o.newOrder === "random" ? "вразброс" : o.newOrder === "reverse" ? "с конца" : "по порядку"}, ${o.algo === "fsrs" ? "FSRS" : "SM-2"}</span></span></summary>
  <div class="optgrid">
    <fieldset><legend>Порядок показа</legend>
      <label>Новые слова${sel("newOrder", o.newOrder, [["seq", "По порядку, как в списке"], ["random", "Вразброс"], ["reverse", "С конца списка"]])}</label>
      <label>Повторения${sel("revOrder", o.revOrder, [["due", "Сначала самые просроченные"], ["random", "Вразброс"]])}</label>
      <label>Новые и повторения${sel("mix", o.mix, [["mix", "Вперемешку"], ["rev_first", "Сначала повторения"], ["new_first", "Сначала новые"]])}</label>
      <label>Сторона вопроса${sel("dir", o.dir, [["fwd", "Слово → перевод"], ["rev", "Перевод → слово"], ["both", "В обе стороны, вразброс"]])}</label>
    </fieldset>
    ${deck.lang === "ar" ? `<fieldset><legend>Арабский</legend>
      <label>Огласовки (харакаты)${sel("harakat", o.harakat, [["show", "Показывать всегда"], ["q", "Скрывать в вопросе, показывать в ответе"], ["hide", "Скрывать везде (кроме словаря)"]])}</label>
      <label class="check"><input type="checkbox" data-opt="translit" ${o.translit !== false ? "checked" : ""}>Показывать транслитерацию в ответе</label>
      <label>Шрифт <span class="small">(для всех колод)</span><select data-pref="arFont">${Object.entries(AR_FONTS).map(([k, [, t]]) => `<option value="${k}" ${prefs.arFont === k ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>Размер арабского текста<select data-pref="arSize">${Object.entries(AR_SIZES).map(([k, [, t]]) => `<option value="${k}" ${prefs.arSize === k ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <p class="font-preview"><span class="ar" lang="ar" dir="rtl">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ · كِتَابٌ جَدِيدٌ</span></p>
    </fieldset>` : ""}
    <fieldset><legend>Лимиты на день</legend>
      <label>Новых слов<input id="dk-new" type="number" min="0" max="9999" value="${deck.newPerDay ?? S.DEFAULT_NEW_PER_DAY}"></label>
      <label>Повторений, не больше<input data-opt="maxRev" type="number" min="0" max="9999" value="${o.maxRev}"></label>
    </fieldset>
    <fieldset><legend>Шаги изучения</legend>
      <label>Для нового слова<input data-opt="steps" value="${S.fmtSteps(o.steps)}" placeholder="1м 10м"></label>
      <label>После ошибки в повторении<input data-opt="relearn" value="${S.fmtSteps(o.relearn)}" placeholder="10м"></label>
      <p class="muted small">Через сколько слово вернётся, пока не перейдёт в долгие повторения. Пишите через пробел: <code>1м 10м 1ч 1д</code>. Пусто: слово сразу уходит в повторения.</p>
      <label class="check"><input type="checkbox" data-opt="learnAhead" ${o.learnAhead ? "checked" : ""}>Показывать изучаемые слова раньше срока, если больше нечего учить</label>
    </fieldset>
    <fieldset><legend>Алгоритм интервалов</legend>
      <label>Алгоритм${sel("algo", o.algo, [["sm2", "SM-2, классический Anki"], ["fsrs", "FSRS, как в новом Anki"]])}</label>
      ${o.algo === "fsrs" ? `<label>Желаемая запоминаемость, %<input data-opt="retention" type="number" min="70" max="99" value="${Math.round(o.retention * 100)}"></label>
        <p class="muted small">FSRS ставит повтор на момент, когда вы с этой вероятностью ещё помните слово. 90% подходит большинству. Выше — больше повторений, ниже — меньше, но больше забывания.</p>`
      : `<label>Первый интервал после «Хорошо», дней<input data-opt="gradIvl" type="number" min="1" max="365" value="${o.gradIvl}"></label>
        <label>После «Легко», дней<input data-opt="easyIvl" type="number" min="1" max="365" value="${o.easyIvl}"></label>`}
      <label>Максимальный интервал, дней<input data-opt="maxIvl" type="number" min="1" max="36500" value="${o.maxIvl}"></label>
    </fieldset>
    <fieldset><legend>Трудные слова</legend>
      <label>Считать трудным после ошибок<input data-opt="leech" type="number" min="2" max="99" value="${o.leech}"></label>
      <label>Что делать с трудным словом${sel("leechAction", o.leechAction, [["flag", "Только отметить"], ["suspend", "Убрать из повторений"]])}</label>
    </fieldset>
  </div>
  <p class="small" id="opts-msg" hidden></p>
  <div class="row"><button class="chip" data-act="opts-all">Применить ко всем колодам</button><button class="chip" data-act="opts-reset">Вернуть по умолчанию</button></div>
  </details>`;
}
function setOpt(deck, key, el) {
  const msg = document.getElementById("opts-msg");
  const say = (t, bad) => { if (msg) { msg.hidden = false; msg.textContent = t; msg.style.color = bad ? "var(--again)" : ""; } };
  let v;
  if (key === "steps" || key === "relearn") { v = S.parseSteps(el.value); if (!v) return say("Не понял шаги. Пример: 1м 10м 1д", true); }
  else if (el.type === "checkbox") v = el.checked;
  else if (el.type === "number") { v = parseFloat(el.value); if (!Number.isFinite(v)) return say("Введите число", true); if (key === "retention") v = Math.min(99, Math.max(70, v)) / 100; }
  else v = el.value;
  deck.opts = { ...(deck.opts || {}), [key]: v };
  if (key === "dir") deck.reverse = v === "rev";
  saveDeck(deck); say("Сохранено");
  if (key === "algo") render();
}
function cardListHtml(deck, now) {
  if (!deck.cards.length) return `<p class="muted">В колоде пока нет карточек.</p>`;
  const q = S.normalize(state.view.q || ""), limit = state.view.limit || 100;
  const list = q ? deck.cards.filter(x => S.normalize(x.f).includes(q) || S.normalize(x.b).includes(q)) : deck.cards;
  if (!list.length) return `<p class="muted">Ничего не нашлось.</p>`;
  return `<div class="cardlist">${list.slice(0, limit).map(x => `<div class="cl-row"><div>${T(x.f, deck)}</div><div class="b">${T(x.b, deck)}</div><div class="row acts" style="gap:6px;justify-content:flex-end"><span class="st">${stateLabel(x, now)}</span><button class="chip" data-act="edit" data-id="${x.id}">Изм.</button><button class="chip" data-act="del-card" data-id="${x.id}" aria-label="Удалить карточку">✕</button></div></div>`).join("")}</div>
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
        return `<div><span>${arWrap(esc(f)) || '<i class="muted">пусто</i>'}</span><span class="muted">${arWrap(esc(b)) || "пусто"}</span></div>`;
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
  const t = e.target;
  if (t.dataset && t.dataset.opt && state.view.name === "deck") { setOpt(state.decks[state.view.deck], t.dataset.opt, t); return; }
  if (t.dataset && t.dataset.pref) { prefs[t.dataset.pref] = t.value; savePrefs(); return; }
  const kind = t.dataset && t.dataset.imp; if (!kind || !state.imp) return;
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
  const deck = state.decks[state.view.deck], now = Date.now(), o = S.deckOpts(deck);
  const locked = state.view.lock && deck.cards.find(x => x.id === state.view.lock && !x.sus);
  let card = locked || nextCard(deck, now);
  if (!card && state.view.ahead) card = S.earliestLearning(deck);
  const c = counts(deck, now);
  if (!card) {
    const nd = nextLearnDue(deck), td = todayStats(), mins = nd ? Math.max(1, Math.round((nd - now) / 60000)) : 0;
    const sameDay = nd && nd < dayStart(now) + DAY;
    const left = c.newTotal - c.n;
    app.innerHTML = `<div class="row"><button class="chip" data-act="home">← Колоды</button></div>
      <div class="panel done"><div class="big">${sameDay ? "Пауза для памяти" : "На сегодня всё"}</div>
      <p class="muted">${sameDay ? `Слова на изучении вернутся через ${mins} мин: короткий перерыв помогает запомнить их надёжнее.` : `Сегодня ${td.r || 0} ${plural(td.r || 0, "ответ", "ответа", "ответов")}. Следующие повторения уже запланированы.`}</p>
      ${!sameDay && left > 0 ? `<p class="small muted">Новых слов на сегодня больше нет: лимит ${deck.newPerDay} в день. Ещё ${left} ждут своей очереди. Лимит меняется в «Параметрах изучения».</p>` : ""}
      <div class="row" style="justify-content:center">${sameDay ? `<button class="btn" data-act="study-ahead">Повторить сейчас</button>` : ""}${!sameDay && left > 0 ? `<button class="btn" data-act="more-new" data-id="${deck.id}">Ещё 10 новых слов</button>` : ""}${deck.cards.length >= 4 ? `<button class="btn ghost" data-act="quick-test" data-id="${deck.id}">Пройти тест</button>` : ""}<button class="btn ghost" data-act="home">К колодам</button></div></div>`;
    state.view.card = null; return;
  }
  if (state.view.card !== card.id) { state.view.card = card.id; state.view.typed = null; }
  state.view.lock = card.id;
  const rev = S.cardDirection(deck, card) === "rev";
  const q = rev ? card.b : card.f, a = rev ? card.f : card.b;
  const shown = !!state.view.shown;
  const opts = [1, 2, 3, 4].map(r => fmtInterval(schedule(card, r, now, true, o), now));
  const kind = card.s === 0 ? "c-new" : card.s === 2 ? "c-due" : "c-learn";
  const typed = state.view.typed;
  const verdict = typed != null ? checkAnswer(typed, a) : null;
  const nth = card.s === 0 ? `Новое слово · ${deck.cards.filter(x => x.s !== 0).length + 1}-е из ${deck.cards.length}` : card.s === 2 ? `Повторение · ${card.reps} ${plural(card.reps, "раз", "раза", "раз")}` : "Изучаю";
  app.innerHTML = `<div class="study-top"><button class="chip" data-act="home">← ${esc(deck.name)}</button>
    <div class="row" style="gap:12px">${state.undo && state.undo.deck === deck.id ? `<button class="chip" data-act="undo">Отменить ответ</button>` : ""}<div class="counts" title="Новые / Изучаю / Повтор"><span class="c-new">${c.n}</span><span class="c-learn">${c.l}</span><span class="c-due">${c.r}</span></div></div></div>
    <div class="scene"><div class="card ${shown ? "flip" : ""}" aria-live="polite">
      <span class="tag ${kind}">${nth}${card.flag ? " · ★ трудное" : ""}</span>
      <div class="face">${T(q, deck, shown ? "a" : "q")}</div>
      ${shown && !rev ? translitHtml(q, deck) : ""}
      ${rev && !shown ? "" : `<button class="speak" data-act="speak" data-text="${esc(card.f)}" aria-label="Произнести слово">${I.speak}</button>`}
      ${shown ? `<hr>${verdict ? `<div class="typed ${verdict}">${verdict === "wrong" ? "Ваш ответ: " + arWrap(esc(typed || "—")) : verdict === "typo" ? (S.hasArabic(a) ? "Верно по буквам, сверьте огласовки и хамзу: " : "Почти верно: ") + arWrap(esc(typed)) : "Верно!"}</div>` : ""}<div class="back">${T(a, deck, "a")}</div>${rev ? translitHtml(a, deck) : ""}` : ""}
    </div></div>
    ${shown ? `<div class="answers">
      <button class="ans a1" data-act="rate" data-r="1">Снова<span>${opts[0]}</span></button>
      <button class="ans a2" data-act="rate" data-r="2">Трудно<span>${opts[1]}</span></button>
      <button class="ans a3" data-act="rate" data-r="3">Хорошо<span>${opts[2]}</span></button>
      <button class="ans a4" data-act="rate" data-r="4">Легко<span>${opts[3]}</span></button></div>
      <div class="row" style="justify-content:center;gap:8px"><button class="chip" data-act="word-from-study">Формы и примеры</button><button class="chip" data-act="flag-card">${card.flag ? "Снять «трудное»" : "★ Трудное"}</button><button class="chip" data-act="suspend-card">Не показывать</button></div>
      <p class="kbd">Клавиши 1–4 для ответа${verdict === "wrong" ? ". Совет: при ошибке нажмите «Снова»" : ""}</p>`
    : deck.typeIn ? `<form id="type-form" class="row" style="flex-wrap:nowrap"><input dir="auto" id="type-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Ваш ответ" style="flex:1;min-width:0" ${prefs.arKb && S.hasArabic(a) ? 'inputmode="none"' : ""}><button class="btn" type="submit">Проверить</button></form>${kbToggleHtml(a, "type-in")}<p class="kbd">Enter — проверить</p>`
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
  const old = deck.cards[idx], now = Date.now(), o = S.deckOpts(deck), tk = dayKey(now);
  state.undo = { deck: deck.id, idx, card: old, newDay: deck.newDay, newDone: deck.newDone, revDay: deck.revDay, revDone: deck.revDone, stats: JSON.stringify(state.stats) };
  const wasNew = old.s === 0, wasReview = old.s === 2;
  if (wasNew) { if (deck.newDay !== tk) { deck.newDay = tk; deck.newDone = 0; } deck.newDone++; }
  if (wasReview) { if (deck.revDay !== tk) { deck.revDay = tk; deck.revDone = 0; } deck.revDone = (deck.revDone || 0) + 1; }
  const next = schedule(old, r, now, false, o);
  if (wasReview && r === 1 && next.lapses >= o.leech && (next.lapses - o.leech) % Math.max(1, Math.ceil(o.leech / 2)) === 0) {
    next.flag = 1; if (o.leechAction === "suspend") next.sus = 1;
    state.flash = { until: now + 12000, text: `«${old.f}» часто забывается: слово отмечено как трудное${o.leechAction === "suspend" ? " и убрано из повторений" : ""}. Загляните в «Словарь», чтобы разобрать его с примерами.` };
  }
  deck.cards[idx] = next;
  S.bump(state.stats, now, { r: 1, n: wasNew ? 1 : 0, rv: wasReview ? 1 : 0, ok: wasReview && r > 1 ? 1 : 0 });
  saveDeck(deck); saveStats();
  state.view.shown = false; state.view.typed = null; state.view.lock = null; state.view.ahead = false; render();
}
function undo() {
  const u = state.undo, deck = u && state.decks[u.deck]; if (!deck) return;
  deck.cards[u.idx] = u.card; deck.newDay = u.newDay; deck.newDone = u.newDone; deck.revDay = u.revDay; deck.revDone = u.revDone;
  state.stats = JSON.parse(u.stats); state.undo = null;
  saveDeck(deck); saveStats();
  state.view.card = u.card.id; state.view.lock = u.card.id; state.view.shown = false; state.view.typed = null;
  render();
}
function updateCard(deckId, cardId, patch) {
  const d = state.decks[deckId], i = d ? d.cards.findIndex(c => c.id === cardId) : -1; if (i < 0) return null;
  const c = { ...d.cards[i], ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete c[k];
  d.cards[i] = c; saveDeck(d); return c;
}

/* ---------- dictionary ---------- */
const STATUS_RU = { new: "новое", learn: "изучаю", review: "повторяю", known: "знаю", sus: "приостановлено" };
function dictRows() {
  const f = state.dictF || (state.dictF = { q: "", status: "all", deck: "all", sort: "alpha", limit: 100 });
  const q = S.normalize(f.q);
  let rows = [];
  for (const d of deckList()) {
    if (f.deck !== "all" && d.id !== f.deck) continue;
    for (const c of d.cards) {
      const st = S.wordStatus(c);
      if (f.status === "hard" ? !S.isHard(c) : f.status !== "all" && st !== f.status) continue;
      if (q && !S.normalize(c.f).includes(q) && !S.normalize(c.b).includes(q)) continue;
      rows.push({ c, d, st });
    }
  }
  const coll = new Intl.Collator("ru", { sensitivity: "base" });
  if (f.sort === "alpha") rows.sort((a, b) => coll.compare(a.c.f, b.c.f));
  else if (f.sort === "due") rows.sort((a, b) => (a.c.s === 0 ? Infinity : a.c.due) - (b.c.s === 0 ? Infinity : b.c.due));
  else if (f.sort === "lapses") rows.sort((a, b) => (b.c.lapses || 0) - (a.c.lapses || 0));
  else if (f.sort === "recall") rows.sort((a, b) => (S.recallChance(a.c) ?? 2) - (S.recallChance(b.c) ?? 2));
  return rows;
}
function dueText(c, now) {
  if (c.sus) return "не показывается";
  if (c.s === 0) return "ещё не изучали";
  if (S.isLearning(c)) return c.due <= now ? "сейчас" : "сегодня";
  const d = Math.round((c.due - dayStart(now)) / DAY);
  return d <= 0 ? "сегодня" : d === 1 ? "завтра" : "через " + d + " " + plural(d, "день", "дня", "дней");
}
function dictListHtml() {
  const f = state.dictF, rows = dictRows(), now = Date.now();
  if (!rows.length) return `<p class="muted">${deckList().length ? "Ничего не нашлось. Измените поиск или фильтр." : "Слов пока нет: создайте или импортируйте колоду."}</p>`;
  return `<p class="small muted">${rows.length} ${plural(rows.length, "слово", "слова", "слов")}</p><div class="dict">${rows.slice(0, f.limit).map(({ c, d, st }) => `
    <button class="dict-row" data-act="open-word" data-deck="${d.id}" data-id="${c.id}">
      <span class="dw"><b>${T(c.f, d)}</b>${c.flag ? ' <span class="star" aria-label="трудное">★</span>' : ""}<span class="muted">${T(String(c.b).split("\n")[0], d)}</span></span>
      <span class="dm"><span class="pill st-${st}">${STATUS_RU[st]}</span><span class="small muted">${dueText(c, now)}</span></span>
    </button>`).join("")}</div>
    ${rows.length > f.limit ? `<button class="btn ghost" data-act="dict-more">Показать ещё (${Math.min(100, rows.length - f.limit)} из ${rows.length - f.limit})</button>` : ""}`;
}
function renderDict() {
  const decks = deckList(); dictRows();
  const f = state.dictF;
  const all = decks.flatMap(d => d.cards), cnt = { new: 0, learn: 0, review: 0, known: 0, sus: 0 }; let hard = 0;
  for (const c of all) { cnt[S.wordStatus(c)]++; if (S.isHard(c)) hard++; }
  const chip = (v, t, n) => `<button class="chip ${f.status === v ? "on" : ""}" data-act="dict-status" data-id="${v}">${t}${n !== undefined ? ` <span class="cnt">${n}</span>` : ""}</button>`;
  app.innerHTML = `<h1>Словарь</h1>
  <p class="muted">Все ваши слова: что уже знаете, что повторяете, что ещё впереди. Нажмите на слово, чтобы увидеть примеры, формы и прогресс.</p>
  <a class="btn ghost" style="align-self:flex-start;text-decoration:none" href="https://claude.ai/artifact/DLRiJ4GpygqzkwUEHBwkc7" target="_blank" rel="noopener">Разбор фраз: огласовки, перевод, иʿраб →</a>
  <div class="panel">
    <input dir="auto" id="dict-q" type="search" placeholder="Поиск по слову или переводу" value="${esc(f.q)}">
    <div class="row" style="gap:6px">${chip("all", "Все", all.length)}${chip("known", "Знаю", cnt.known)}${chip("review", "Повторяю", cnt.review)}${chip("learn", "Изучаю", cnt.learn)}${chip("new", "Новые", cnt.new)}${chip("hard", "★ Трудные", hard)}${cnt.sus ? chip("sus", "Приостановлены", cnt.sus) : ""}</div>
    <div class="row">
      ${decks.length > 1 ? `<label style="flex:1;min-width:150px">Колода<select id="dict-deck"><option value="all">Все колоды</option>${decks.map(d => `<option value="${d.id}" ${f.deck === d.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></label>` : ""}
      <label style="flex:1;min-width:150px">Сортировка<select id="dict-sort">${[["alpha", "По алфавиту"], ["due", "По следующему повтору"], ["recall", "Сначала забываемые"], ["lapses", "По числу ошибок"]].map(([v, t]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    </div>
  </div>
  <div id="dict-list">${dictListHtml()}</div>`;
  const qI = document.getElementById("dict-q");
  qI.addEventListener("input", () => { f.q = qI.value; f.limit = 100; document.getElementById("dict-list").innerHTML = dictListHtml(); });
  const dk = document.getElementById("dict-deck"); if (dk) dk.addEventListener("change", e => { f.deck = e.target.value; f.limit = 100; render(); });
  document.getElementById("dict-sort").addEventListener("change", e => { f.sort = e.target.value; render(); });
}
function fmtDate(t) { return new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }); }
function renderWord() {
  const v = state.view, deck = state.decks[v.deck], c = deck.cards.find(x => x.id === v.card), now = Date.now();
  const st = S.wordStatus(c), r = S.recallChance(c, now);
  const lines = String(c.b).split("\n"), main = lines[0], extra = lines.slice(1).join("\n");
  const back = v.from === "study" ? `<button class="chip" data-act="back-study">← К учёбе</button>` : `<button class="chip" data-act="back-dict">← Словарь</button>`;
  app.innerHTML = `<div class="row between">${back}<span class="small muted">${esc(deck.name)}</span></div>
  <section class="panel word-head">
    <div class="row between" style="align-items:flex-start;flex-wrap:nowrap"><div style="min-width:0"><h1 class="word-title">${T(v.noHarakat ? S.stripHarakat(c.f) : c.f, deck, "word")}</h1>${translitHtml(c.f, deck) || translitHtml(main, deck)}<p class="word-tr">${T(v.noHarakat ? S.stripHarakat(main) : main, deck, "word")}</p></div>
    <button class="speak" data-act="speak" data-text="${esc(c.f)}" aria-label="Произнести">${I.speak}</button></div>
    ${extra ? `<p class="word-extra">${T(extra, deck, "word")}</p>` : ""}
    ${deck.lang === "ar" && (S.hasHarakat(c.f) || S.hasHarakat(c.b)) ? `<div class="row"><button class="chip ${v.noHarakat ? "on" : ""}" data-act="w-harakat">${v.noHarakat ? "Показать огласовки" : "Прочитать без огласовок"}</button></div>` : ""}
    <div class="row" style="gap:6px"><span class="pill st-${st}">${STATUS_RU[st]}</span>${c.flag ? `<span class="pill st-hard">★ трудное</span>` : ""}</div>
  </section>
  <section class="tiles">
    <div class="tile"><b>${c.reps || 0}</b><span>${plural(c.reps || 0, "повторение", "повторения", "повторений")}</span></div>
    <div class="tile"><b>${c.lapses || 0}</b><span>${plural(c.lapses || 0, "ошибка", "ошибки", "ошибок")} в повторах</span></div>
    <div class="tile"><b>${c.s === 2 ? c.ivl + " д" : "—"}</b><span>текущий интервал</span></div>
    <div class="tile"><b>${r === null ? "—" : Math.round(r * 100) + "%"}</b><span>вероятность вспомнить сейчас</span></div>
  </section>
  <p class="small muted">${c.s === 0 ? "Слово ещё не изучали." : `Следующее повторение: <b>${c.s === 2 ? fmtDate(c.due) + "</b> (" + dueText(c, now) + ")" : "сегодня</b>"}.${c.intro ? " Начали учить " + fmtDate(c.intro) + "." : ""}`}</p>
  <div class="row" style="gap:8px">
    <button class="chip" data-act="w-flag">${c.flag ? "Снять «трудное»" : "★ Отметить трудным"}</button>
    <button class="chip" data-act="w-sus">${c.sus ? "Вернуть в повторения" : "Не показывать"}</button>
    ${c.s === 2 && c.due > dayStart(now) + DAY ? `<button class="chip" data-act="w-today">Повторить сегодня</button>` : ""}
    ${c.s !== 0 ? `<button class="chip" data-act="w-reset">Учить заново</button>` : ""}
    <button class="chip" data-act="w-edit">Изменить</button>
  </div>
  <div id="w-reset-zone"></div>
  ${formsHtml(deck, c)}
  <section class="panel" id="wikt"><h2>Значения и примеры</h2><div id="wikt-body">${wiktPlaceholder(deck, c)}</div></section>`;
  loadWiktionary(deck, c);
}
function formsHtml(deck, c) {
  if ((deck.lang || "en") !== "en") return "";
  const asVerb = state.view.asVerb ?? S.looksLikeVerb(c);
  if (!asVerb) {
    const pl = !/\s/.test(c.f.trim()) ? S.englishPlural(c.f) : null;
    return `<section class="panel"><div class="row between"><h2>Формы слова</h2><button class="chip" data-act="w-verb">Это глагол: показать времена</button></div>
      ${pl ? `<p>Множественное число: <b>${esc(pl.plural)}</b>${pl.irregular ? " (исключение)" : ""}</p><p class="small muted">Если это прилагательное или наречие, множественного числа у него нет.</p>` : `<p class="muted small">Для фраз формы не строятся.</p>`}</section>`;
  }
  const v = S.englishVerb(c.f, c.b);
  if (!v) return "";
  if (v.modal) return `<section class="panel"><h2>Формы слова</h2><p>«${esc(v.base)}» — модальный глагол: он не изменяется по лицам и временам, а после него глагол идёт без «to»: <i>I ${esc(v.base)} go</i>.</p></section>`;
  const kind = state.view.formKind || "aff";
  const seg = (k, t) => `<button class="chip ${kind === k ? "on" : ""}" data-act="w-kind" data-id="${k}">${t}</button>`;
  return `<section class="panel"><div class="row between"><h2>Формы глагола</h2><button class="chip" data-act="w-noverb">Это не глагол</button></div>
    <div class="vforms"><div><span class="muted small">Инфинитив</span><b>to ${esc(v.base + v.tail)}</b></div><div><span class="muted small">Прошедшее (V2)</span><b>${esc(v.past)}</b></div><div><span class="muted small">Причастие (V3)</span><b>${esc(v.pp)}</b></div><div><span class="muted small">-ing форма</span><b>${esc(v.ing)}</b></div></div>
    <p class="small muted">${v.irregular ? "Неправильный глагол: формы V2 и V3 нужно запомнить." : "Правильный глагол: прошедшее время образуется окончанием -ed."}</p>
    <div class="row" style="gap:6px">${seg("aff", "Утверждение")}${seg("neg", "Отрицание")}${seg("q", "Вопрос")}</div>
    ${v.groups.map(g => `<h3 class="tgroup">${g.name}</h3><div class="tenses">${g.tenses.map(t => { const fm = t.forms(kind); return `<div class="tense"><div class="tname"><b>${t.name}</b><span class="small muted">${t.ru}</span></div><div class="tforms">${fm.map(x => `<span>${esc(x)}</span>`).join("")}</div><div class="small muted">Маркеры: ${t.hint}</div></div>`; }).join("")}</div>`).join("")}
  </section>`;
}
const WIKT_UA = "Slovnik/1.0 (personal flashcard app)";
function wiktPlaceholder(deck, c) {
  if (window.claude) return `<p class="muted small">Значения и примеры из Викисловаря доступны в версии-сайте Словника: здесь браузер не пускает приложение в интернет.</p>`;
  return `<div class="row"><div class="spinner" aria-hidden="true"></div><span class="muted small">Загружаю из Викисловаря…</span></div>`;
}
function wiktCacheGet(k) { try { const v = JSON.parse(localStorage.getItem("wikt:" + k) || "null"); return v && Date.now() - v.t < 30 * DAY ? v.d : null; } catch { return null; } }
function wiktCacheSet(k, d) { try { localStorage.setItem("wikt:" + k, JSON.stringify({ t: Date.now(), d })); } catch {} }
async function loadWiktionary(deck, c) {
  if (window.claude) return;
  const body = () => document.getElementById("wikt-body");
  const lang = deck.lang && deck.lang !== "other" ? deck.lang : "en";
  const word = S.lookupWord(c, lang), key = lang + ":" + word, viewCard = c.id;
  const stillHere = () => state.view.name === "word" && state.view.card === viewCard && body();
  const link = `https://en.wiktionary.org/wiki/${encodeURIComponent(word.replace(/ /g, "_"))}${S.LANGS[lang] ? "#" + S.LANGS[lang] : ""}`;
  if (!word) { if (stillHere()) body().innerHTML = `<p class="muted small">Для этой карточки нечего искать.</p>`; return; }
  let data = wiktCacheGet(key);
  if (!data) {
    try {
      const opt = { headers: { "Api-User-Agent": WIKT_UA } };
      const get = w => Promise.all([
        fetch("https://en.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(w.replace(/ /g, "_")), opt),
        fetch("https://en.wiktionary.org/api/rest_v1/page/html/" + encodeURIComponent(w.replace(/ /g, "_")), opt)
      ]);
      let [defRes, htmlRes] = await get(word);
      if (defRes.status === 404 && lang === "ar" && /^ال/.test(word) && word.length > 3) [defRes, htmlRes] = await get(word.slice(2));
      if (defRes.status === 404) data = { defs: [], tables: [], heads: [] };
      else if (!defRes.ok) throw new Error("status " + defRes.status);
      else {
        const defs = S.parseWiktDefinitions(await defRes.json(), lang);
        const page = htmlRes.ok ? extractInflection(await htmlRes.text(), S.LANGS[lang] || "English") : { tables: [], heads: [] };
        data = { defs, tables: page.tables, heads: page.heads, root: page.root };
      }
      wiktCacheSet(key, data);
    } catch (e) {
      if (stillHere()) body().innerHTML = `<p class="muted small">Не удалось загрузить: ${navigator.onLine === false ? "нет интернета" : "Викисловарь не ответил"}. <a href="${link}" target="_blank" rel="noopener">Открыть статью</a></p>`;
      return;
    }
  }
  if (!stillHere()) return;
  if (!data.defs.length && !data.tables.length) { body().innerHTML = `<p class="muted small">В Викисловаре нет статьи «${esc(word)}» для языка «${esc(S.LANG_RU[lang] || lang)}». Проверьте язык колоды в её настройках.</p>`; return; }
  body().innerHTML = `${data.root ? `<p class="root">Корень: <span class="ar" lang="ar" dir="rtl">${esc(data.root)}</span></p>` : ""}
    ${data.heads.length ? `<p class="small heads">${data.heads.map(h => arWrap(esc(h))).join("<br>")}</p>` : ""}
    ${data.defs.slice(0, 4).map(p => `<div class="pos"><span class="pill">${esc(p.posRu)}</span><ol>${p.defs.slice(0, 5).map(d => `<li>${arWrap(esc(d.text))}${d.examples.slice(0, 2).map(x => `<div class="ex">${arWrap(esc(x))}</div>`).join("")}</li>`).join("")}</ol></div>`).join("")}
    ${data.tables.length ? `<h3>Таблица форм</h3>${data.tables.slice(0, 2).map(t => `<div class="wtable">${t}</div>`).join("")}` : ""}
    <p class="small muted">Источник: <a href="${link}" target="_blank" rel="noopener">Викисловарь</a>, CC BY-SA. Определения на английском.</p>`;
}
const SAFE_CELL = new Set(["TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "CAPTION", "BR"]);
function cleanTable(node) {
  const out = document.createElement(SAFE_CELL.has(node.tagName) ? node.tagName.toLowerCase() : "span");
  for (const a of ["colspan", "rowspan"]) if (node.getAttribute && node.getAttribute(a)) out.setAttribute(a, node.getAttribute(a));
  for (const ch of node.childNodes) {
    if (ch.nodeType === 3) { if (S.hasArabic(ch.textContent)) { const sp = document.createElement("span"); sp.className = "ar"; sp.lang = "ar"; sp.dir = "rtl"; sp.textContent = ch.textContent; out.appendChild(sp); } else out.appendChild(document.createTextNode(ch.textContent)); }
    else if (ch.nodeType === 1 && !/^(STYLE|SCRIPT|SUP|LINK|META|IMG|BUTTON)$/.test(ch.tagName) && !(ch.classList && (ch.classList.contains("reference") || ch.classList.contains("mw-editsection")))) out.appendChild(cleanTable(ch));
  }
  return out;
}
function extractInflection(html, langName) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let root = "";
  for (const l of doc.querySelectorAll("link[href], a[href]")) {
    const m = decodeURIComponent(l.getAttribute("href") || "").replace(/_/g, " ").match(/Category:Arabic terms belonging to the root (.+)$/);
    if (m) { root = m[1].trim(); break; }
  }
  const h2 = [...doc.querySelectorAll("h2")].find(h => h.textContent.replace(/\[edit\]/, "").trim() === langName);
  if (!h2) return { tables: [], heads: [], root };
  let scope = h2.closest("section");
  if (!scope || scope.querySelectorAll("h2").length > 1) {
    scope = doc.createElement("div");
    let n = (h2.closest(".mw-heading") || h2).nextElementSibling;
    while (n && !(n.tagName === "H2" || (n.querySelector && n.querySelector(":scope > h2")) || n.matches(".mw-heading2"))) { scope.appendChild(n.cloneNode(true)); n = n.nextElementSibling; }
  }
  const heads = [...scope.querySelectorAll(".headword-line")].map(x => x.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3);
  const tables = [...scope.querySelectorAll("table.inflection-table, table.inflection, .NavFrame table, table.wikitable")]
    .filter((t, i, all) => !all.some(o => o !== t && o.contains(t)))
    .slice(0, 2).map(t => cleanTable(t).outerHTML);
  return { tables, heads, root };
}

/* ---------- tests ---------- */
const MODES = [
  { id: "choice", name: "Выбор ответа", desc: "Четыре варианта, один верный", icon: I.choice, min: 4 },
  { id: "type", name: "Написать перевод", desc: "Проверка с учётом опечаток", icon: I.type, min: 1 },
  { id: "pairs", name: "Найди пары", desc: "Соедините слова с переводами на время", icon: I.pairs, min: 3 }
];
function renderTestSetup() {
  const decks = deckList();
  const cfg = state.testCfg || (state.testCfg = { deck: "all", mode: "choice", dir: "fwd", count: 10, source: "all", timed: false });
  if (cfg.deck !== "all" && !state.decks[cfg.deck]) cfg.deck = "all";
  const pool = testPool(cfg).map(x => x.c);
  const mode = MODES.find(m => m.id === cfg.mode);
  if (!decks.length) { app.innerHTML = `<h1>Тесты</h1><div class="empty"><p class="muted">Сначала создайте или импортируйте колоду: тесты строятся из ваших слов.</p><div class="row"><button class="btn" data-act="import">Импорт файла</button><button class="btn ghost" data-act="sample">Пример колоды</button></div></div>`; return; }
  app.innerHTML = `<h1>Тесты</h1>
  <p class="muted">Быстрая проверка без влияния на расписание повторений. Слова с ошибками можно сразу отправить на повторение.</p>
  <div class="modes">${MODES.map(m => `<button class="mode" data-act="t-mode" data-id="${m.id}" aria-pressed="${m.id === cfg.mode}">${m.icon}<b>${m.name}</b><span>${m.desc}</span></button>`).join("")}</div>
  <div class="panel">
    <label>Колода<select id="t-deck"><option value="all">Все колоды</option>${decks.map(d => `<option value="${d.id}" ${cfg.deck === d.id ? "selected" : ""}>${esc(d.name)} (${d.cards.length})</option>`).join("")}</select></label>
    <div class="row"><span class="small muted">Направление:</span><button class="chip ${cfg.dir === "fwd" ? "on" : ""}" data-act="t-dir" data-id="fwd">Слово → перевод</button><button class="chip ${cfg.dir === "rev" ? "on" : ""}" data-act="t-dir" data-id="rev">Перевод → слово</button></div>
    <div class="row"><span class="small muted">Какие слова:</span>${[["all", "Все"], ["studied", "Уже изученные"], ["hard", "★ Трудные"]].map(([v, t]) => `<button class="chip ${(cfg.source || "all") === v ? "on" : ""}" data-act="t-source" data-id="${v}">${t}</button>`).join("")}</div>
    <div class="row"><span class="small muted">Вопросов:</span>${[10, 20, 30, 50].map(n => `<button class="chip ${cfg.count === n ? "on" : ""}" data-act="t-count" data-id="${n}">${n}</button>`).join("")}</div>
    ${cfg.mode === "choice" ? `<label class="check"><input type="checkbox" id="t-timed" ${cfg.timed ? "checked" : ""}>На скорость: 6 секунд на ответ</label>` : ""}
    <p class="small muted">В тесты попадают все слова, кроме приостановленных. Трудные — отмеченные звёздочкой или с тремя и больше ошибками.</p>
    ${pool.length < mode.min ? `<p class="notice warn small">Для этого режима нужно хотя бы ${mode.min} ${plural(mode.min, "карточка", "карточки", "карточек")} в колоде.</p>` : ""}
    <button class="btn" data-act="t-start" ${pool.length < mode.min ? "disabled" : ""}>Начать тест</button>
  </div>`;
  document.getElementById("t-deck").addEventListener("change", e => { cfg.deck = e.target.value; render(); });
  const tt = document.getElementById("t-timed"); if (tt) tt.addEventListener("change", e => { cfg.timed = e.target.checked; });
}
function testPool(cfg) {
  const decks = deckList();
  const pool = (cfg.deck === "all" ? decks : [state.decks[cfg.deck]]).flatMap(d => d.cards.filter(c => !c.sus).map(c => ({ c, d: d.id })));
  if (cfg.source === "hard") return pool.filter(x => S.isHard(x.c));
  if (cfg.source === "studied") return pool.filter(x => x.c.s !== 0);
  return pool;
}
function startTest() {
  const cfg = state.testCfg;
  const pool = testPool(cfg);
  const studied = shuffle(pool.filter(x => x.c.s !== 0)), fresh = shuffle(pool.filter(x => x.c.s === 0));
  const picked = [...studied, ...fresh].slice(0, Math.min(cfg.count, pool.length));
  const qa = x => cfg.dir === "fwd" ? { q: x.c.f, a: x.c.b } : { q: x.c.b, a: x.c.f };
  const items = shuffle(picked).map(x => ({ id: x.c.id, deck: x.d, ...qa(x) }));
  const answersPool = [...new Set((cfg.source === "all" ? pool : testPool({ ...cfg, source: "all" })).map(x => qa(x).a))];
  if (cfg.mode === "choice") items.forEach(it => {
    const wrong = shuffle(answersPool.filter(a => a !== it.a)).slice(0, 3);
    it.options = shuffle([it.a, ...wrong]);
  });
  state.test = { mode: cfg.mode, items, i: 0, results: [], started: Date.now(), picked: null, pairs: null, timed: cfg.mode === "choice" && !!cfg.timed };
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
    const cell = (it, side) => `<button class="pair ${p.done.has(it.id) ? "gone" : ""} ${p.sel && p.sel.side === side && p.sel.id === it.id ? "sel" : ""} ${p.err && p.err[side] === it.id ? "err" : ""}" data-act="pair" data-side="${side}" data-id="${it.id}">${T(side === "l" ? it.q : it.a, state.decks[it.deck], side === "l" ? "q" : "a")}</button>`;
    app.innerHTML = progress + `<p class="muted small">Нажмите слово, затем его перевод.</p><div class="pairs">${p.left.map((it, k) => cell(it, "l") + cell(p.right[k], "r")).join("")}</div>`;
    return;
  }
  const it = t.items[t.i], ans = t.answered;
  let body = `${t.timed && !ans ? `<div class="timer"><i id="t-timer"></i></div>` : ""}<div class="card" style="min-height:190px"><span class="tag muted">${t.mode === "choice" ? "Выберите перевод" : "Напишите перевод"}</span><div class="face">${T(it.q, state.decks[it.deck], "q")}</div></div>`;
  if (t.mode === "choice") {
    body += `<div class="options">${it.options.map((o, k) => {
      const cls = ans ? (o === it.a ? "right" : o === ans.given ? "wrong" : "") : "";
      return `<button class="opt ${cls}" data-act="t-pick" data-k="${k}" ${ans ? "disabled" : ""}><kbd>${k + 1}</kbd><span>${T(o, state.decks[it.deck], "a")}</span></button>`;
    }).join("")}</div>`;
  } else {
    body += ans ? `<div class="panel" style="background:${ans.ok ? "var(--ok-bg)" : "var(--bad-bg)"}"><b>${ans.verdict === "correct" ? "Верно!" : ans.verdict === "typo" ? "Почти верно, проверьте написание" : "Неверно"}</b>${ans.verdict !== "correct" ? `<p>Правильно: <b>${esc(it.a)}</b></p>` : ""}${ans.verdict === "wrong" && ans.given ? `<p class="small muted">Ваш ответ: ${esc(ans.given)}</p>` : ""}</div>`
      : `<form id="t-form" class="row" style="flex-wrap:nowrap"><input dir="auto" id="t-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Перевод" style="flex:1;min-width:0" ${prefs.arKb && S.hasArabic(it.a) ? 'inputmode="none"' : ""}><button class="btn" type="submit">Проверить</button></form>${kbToggleHtml(it.a, "t-input")}<button class="chip" data-act="t-dunno" style="align-self:flex-start">Не знаю</button>`;
  }
  if (ans && !(t.mode === "choice" && ans.ok)) body += `<button class="btn" data-act="t-next" id="t-next">${t.i + 1 < total ? "Дальше" : "Результаты"}</button>`;
  app.innerHTML = progress + body;
  const form = document.getElementById("t-form");
  if (form) { const inp = document.getElementById("t-input"); inp.focus(); form.addEventListener("submit", e => { e.preventDefault(); answerTyped(inp.value); }); }
  const nx = document.getElementById("t-next"); if (nx) nx.focus();
  if (t.timed && !ans) {
    const bar = document.getElementById("t-timer"), qi = t.i, startAt = Date.now(), LIMIT = 6000;
    clearInterval(t.tick);
    t.tick = setInterval(() => {
      if (state.test !== t || t.i !== qi || t.answered) return clearInterval(t.tick);
      const left = Math.max(0, 1 - (Date.now() - startAt) / LIMIT); if (bar) bar.style.width = left * 100 + "%";
      if (left <= 0) { clearInterval(t.tick); t.answered = { given: "", ok: false, timeout: true }; record(false, "время вышло"); render(); }
    }, 100);
  }
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
    <div class="mistakes">${wrong.map(r => `<div><span>${arWrap(esc(r.q))}</span><span><b>${arWrap(esc(r.a))}</b>${r.given ? `<br><span class="small muted">вы: ${esc(r.given)}</span>` : ""}</span></div>`).join("")}</div></div>` : ""}
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
  ${storagePanel()}
  ${accountPanel()}`;
  document.getElementById("goal").addEventListener("change", e => { state.stats.goal = Math.max(5, Math.min(1000, parseInt(e.target.value, 10) || 20)); saveStats(); });
}

function storagePanel() {
  const st = state.store;
  if (st.kind !== "local") return "";
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent), standalone = window.navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
  return `<div class="panel"><h3>Где хранятся колоды</h3>
    <p class="small">В памяти этого браузера (${st.engine}). ${state.persisted ? "Браузер обещал не удалять эти данные при нехватке места." : "Браузер может удалить данные при нехватке места."}</p>
    ${ios && !standalone ? `<p class="notice warn small">На iPhone Safari стирает данные сайтов, которые не открывали 7 дней. Установите Словник на экран «Домой» («Поделиться» → «На экран Домой») и учите оттуда: у приложения с экрана «Домой» данные не стираются. Колоды в Safari и на экране «Домой» хранятся раздельно: перенесите их резервной копией.</p>` : ""}
  </div>`;
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
    "speak": () => speak(b.dataset.text, (state.decks[state.view.deck] || {}).lang), "export": exportDeck,
    "study-ahead": () => { state.view.ahead = true; render(); },
    "more-new": () => { const d = state.decks[id], tk = dayKey(Date.now()); d.newDone = (d.newDay === tk ? d.newDone : 0) - 10; d.newDay = tk; saveDeck(d); render(); },
    "flag-card": () => { const c = updateCard(state.view.deck, state.view.card, { flag: (state.decks[state.view.deck].cards.find(x => x.id === state.view.card) || {}).flag ? undefined : 1 }); if (c) render(); },
    "suspend-card": () => { updateCard(state.view.deck, state.view.card, { sus: 1 }); state.view.shown = false; state.view.lock = null; state.flash = { until: Date.now() + 8000, text: "Слово больше не показывается. Вернуть его можно в «Словаре»." }; render(); },
    "word-from-study": () => go({ name: "word", deck: state.view.deck, card: state.view.card, from: "study", backView: { ...state.view } }),
    "back-study": () => { const bv = state.view.backView; go(bv || { name: "home" }); },
    "back-dict": () => go({ name: "dict" }),
    "open-word": () => go({ name: "word", deck: b.dataset.deck, card: id }),
    "dict-status": () => { state.dictF.status = id; state.dictF.limit = 100; render(); },
    "dict-more": () => { state.dictF.limit += 100; document.getElementById("dict-list").innerHTML = dictListHtml(); },
    "w-flag": () => { const c = state.decks[state.view.deck].cards.find(x => x.id === state.view.card); updateCard(state.view.deck, c.id, { flag: c.flag ? undefined : 1 }); render(); },
    "w-sus": () => { const c = state.decks[state.view.deck].cards.find(x => x.id === state.view.card); updateCard(state.view.deck, c.id, { sus: c.sus ? undefined : 1 }); render(); },
    "w-today": () => { updateCard(state.view.deck, state.view.card, { due: dayStart(Date.now()) }); render(); },
    "w-reset": () => { document.getElementById("w-reset-zone").innerHTML = `<div class="row notice"><span>Стереть прогресс по этому слову и учить его как новое?</span><button class="btn danger" data-act="w-reset-yes">Да</button><button class="btn ghost" data-act="w-reset-no">Отмена</button></div>`; },
    "w-reset-no": () => { document.getElementById("w-reset-zone").innerHTML = ""; },
    "w-reset-yes": () => { updateCard(state.view.deck, state.view.card, { s: 0, due: 0, ivl: 0, ease: 2.5, step: 0, reps: 0, lapses: 0, intro: undefined, fs: undefined, fd: undefined, last: undefined, flag: undefined }); render(); },
    "w-edit": () => go({ name: "deck", deck: state.view.deck, edit: state.view.card }),
    "w-verb": () => { state.view.asVerb = true; render(); }, "w-noverb": () => { state.view.asVerb = false; render(); },
    "w-kind": () => { state.view.formKind = id; render(); },
    "opts-all": () => { const src = state.decks[state.view.deck]; for (const d of deckList()) if (d !== src) { d.opts = { ...(src.opts || {}) }; d.newPerDay = src.newPerDay; saveDeck(d); } const m = document.getElementById("opts-msg"); m.hidden = false; m.textContent = "Параметры применены ко всем колодам"; },
    "opts-reset": () => { const d = state.decks[state.view.deck]; d.opts = {}; d.newPerDay = S.DEFAULT_NEW_PER_DAY; d.reverse = false; saveDeck(d); render(); },
    "t-source": () => { state.testCfg.source = id; render(); },
    "sample-ar": () => { const d = createDeck("Арабский: первые слова (пример)", SAMPLE_AR.map(([f, b2]) => newCard(f, b2))); d.lang = "ar"; saveDeck(d); go({ name: "home" }); },
    "ak": () => { const kb = b.closest(".arkb"); if (kb) typeKey(kb.dataset.target, b.dataset.k); },
    "ak-toggle": () => {
      const inp = document.getElementById("type-in") || document.getElementById("t-input"); const keep = inp ? inp.value : "";
      prefs.arKb = !prefs.arKb; savePrefs(); render();
      const again = document.getElementById("type-in") || document.getElementById("t-input"); if (again) { again.value = keep; if (!prefs.arKb) again.focus(); }
    },
    "w-harakat": () => { state.view.noHarakat = !state.view.noHarakat; render(); },
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
