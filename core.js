window.Slovnik = (() => {
"use strict";
const MIN = 60e3, DAY = 864e5;
const LEARN_STEPS = [1, 10];
const RELEARN_STEPS = [10];
const DEFAULT_NEW_PER_DAY = 20;
const LEARN_AHEAD = 20 * MIN;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const dayStart = t => { const d = new Date(t); d.setHours(4, 0, 0, 0); if (new Date(t).getHours() < 4) d.setDate(d.getDate() - 1); return d.getTime(); };
const dayKey = t => { const d = new Date(dayStart(t)); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const shuffle = a => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

/* ---------- deck serialization ---------- */
const CARD_KEYS = ["id","f","b","s","due","ivl","ease","step","reps","lapses","intro"];
function serialize(deck) {
  return { name: deck.name, created: deck.created, newPerDay: deck.newPerDay, reverse: !!deck.reverse, typeIn: !!deck.typeIn,
    newDay: deck.newDay || "", newDone: deck.newDone || 0,
    cards: deck.cards.map(c => CARD_KEYS.map(k => c[k] ?? null)) };
}
function deserialize(id, v) {
  return { id, name: v.name || "Без названия", created: v.created || 0, newPerDay: v.newPerDay ?? DEFAULT_NEW_PER_DAY,
    reverse: !!v.reverse, typeIn: !!v.typeIn, newDay: v.newDay || "", newDone: v.newDone || 0,
    cards: (v.cards || []).map(a => cardFromRow(a)) };
}
const byteSize = obj => new TextEncoder().encode(JSON.stringify(obj)).length;

/* ---------- scheduler: Anki SM-2 ---------- */
/* card.s: 0 new, 1 learning, 2 review, 3 relearning */
function newCard(f, b) { return { id: uid(), f, b, s: 0, due: 0, ivl: 0, ease: 2.5, step: 0, reps: 0, lapses: 0 }; }
function fuzz(ivl) { if (ivl < 3) return ivl; const r = Math.max(1, Math.round(ivl * 0.05)); return ivl + Math.round((Math.random() * 2 - 1) * r); }
const dueInDays = (days, now) => dayStart(now) + days * DAY;

function schedule(card, rating, now, preview) {
  const c = { ...card };
  const steps = c.s === 3 ? RELEARN_STEPS : LEARN_STEPS;
  if (c.s !== 2) {
    const wasRelearn = c.s === 3;
    if (c.s === 0) { c.s = 1; c.step = 0; if (!preview) c.intro = now; }
    if (rating === 1) { c.step = 0; c.due = now + steps[0] * MIN; }
    else if (rating === 2) {
      const m = c.step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[c.step] * 1.5;
      c.due = now + m * MIN;
    } else if (rating === 3) {
      if (c.step + 1 < steps.length) { c.step++; c.due = now + steps[c.step] * MIN; }
      else { c.s = 2; c.ivl = wasRelearn ? Math.max(1, c.ivl) : 1; c.due = dueInDays(c.ivl, now); c.step = 0; }
    } else { c.s = 2; c.ivl = wasRelearn ? Math.max(2, c.ivl + 1) : 4; c.due = dueInDays(c.ivl, now); c.step = 0; }
  } else {
    const late = Math.max(0, Math.floor((dayStart(now) - c.due) / DAY));
    if (rating === 1) {
      c.lapses++; c.ease = Math.max(1.3, c.ease - 0.2); c.ivl = Math.max(1, Math.round(c.ivl * 0.2));
      c.s = 3; c.step = 0; c.due = now + RELEARN_STEPS[0] * MIN;
    } else {
      let ivl;
      if (rating === 2) { ivl = c.ivl * 1.2; c.ease = Math.max(1.3, c.ease - 0.15); }
      else if (rating === 3) ivl = (c.ivl + late / 2) * c.ease;
      else { ivl = (c.ivl + late) * c.ease * 1.3; c.ease += 0.15; }
      ivl = Math.max(c.ivl + 1, Math.round(ivl));
      if (rating === 4) ivl = Math.max(ivl, Math.round((c.ivl + late / 2) * card.ease) + 1);
      c.ivl = preview ? ivl : Math.min(36500, fuzz(ivl)); c.due = dueInDays(c.ivl, now);
    }
  }
  if (!preview) c.reps++;
  return c;
}
function fmtInterval(next, now) {
  if (next.s === 1 || next.s === 3) { const m = Math.round((next.due - now) / MIN); return m < 60 ? m + " мин" : Math.round(m / 60) + " ч"; }
  const d = next.ivl;
  if (d < 30) return d + " д";
  if (d < 365) return (d / 30).toFixed(1).replace(".0", "") + " мес";
  return (d / 365).toFixed(1).replace(".0", "") + " г";
}

/* ---------- queues ---------- */
const newLeft = (deck, now = Date.now()) => Math.max(0, (deck.newPerDay ?? DEFAULT_NEW_PER_DAY) - (deck.newDay === dayKey(now) ? deck.newDone : 0));
function counts(deck, now = Date.now()) {
  const end = dayStart(now) + DAY;
  let n = 0, l = 0, r = 0;
  for (const c of deck.cards) {
    if (c.s === 0) n++;
    else if (c.s === 1 || c.s === 3) { if (c.due < end) l++; }
    else if (c.due < end) r++;
  }
  return { n: Math.min(n, newLeft(deck, now)), l, r, total: deck.cards.length };
}
function nextCard(deck, now = Date.now()) {
  const end = dayStart(now) + DAY;
  const byDue = (a, b) => a.due - b.due;
  const learnNow = deck.cards.filter(c => (c.s === 1 || c.s === 3) && c.due <= now).sort(byDue);
  if (learnNow.length) return learnNow[0];
  const reviews = deck.cards.filter(c => c.s === 2 && c.due < end).sort(byDue);
  const news = newLeft(deck, now) > 0 ? deck.cards.filter(c => c.s === 0) : [];
  const studied = deck.cards.reduce((s, c) => s + (c.reps || 0), 0);
  if (reviews.length && news.length) return studied % 4 === 3 ? news[0] : reviews[0];
  if (reviews.length) return reviews[0];
  if (news.length) return news[0];
  const ahead = deck.cards.filter(c => (c.s === 1 || c.s === 3) && c.due <= now + LEARN_AHEAD).sort(byDue);
  return ahead[0] || null;
}
function nextLearnDue(deck) {
  const l = deck.cards.filter(c => c.s === 1 || c.s === 3).sort((a, b) => a.due - b.due);
  return l.length ? l[0].due : null;
}

/* ---------- answer checking ---------- */
function normalize(s) {
  return String(s).toLowerCase().replace(/ё/g, "е").replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
}
const stripArticle = s => s.replace(/^(to|the|a|an|der|die|das|le|la|les|el|los|las|il|lo|un|une)\s+/, "");
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function checkAnswer(input, expected) {
  const given = normalize(input); if (!given) return "wrong";
  const variants = new Set([normalize(expected), ...String(expected).split(/[,;/\n]| или /).map(normalize)].filter(Boolean));
  for (const v of variants) if (v === given || stripArticle(v) === stripArticle(given)) return "correct";
  for (const v of variants) {
    const a = stripArticle(v), b = stripArticle(given), d = levenshtein(a, b);
    if ((a.length >= 4 && d <= 1) || (a.length >= 8 && d <= 2)) return "typo";
  }
  return "wrong";
}

/* ---------- text import ---------- */
function splitListLine(line) {
  let parts;
  if (line.includes("\t")) parts = line.split("\t");
  else if (/\s[—–-]\s/.test(line)) parts = line.split(/\s[—–-]\s/);
  else if (line.includes(";")) parts = line.split(";");
  else if (line.includes("=")) parts = line.split("=");
  else if (line.includes(",")) parts = line.split(",");
  else return null;
  const f = parts[0].trim().replace(/^"|"$/g, ""), b = parts.slice(1).join(", ").trim().replace(/^"|"$/g, "");
  return f && b ? [f, b] : null;
}
function parseImport(text) {
  return text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#")).map(splitListLine).filter(Boolean);
}
function parseCSV(text, sep) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"' && field === "") q = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}
const SEP_NAMES = { tab: "\t", comma: ",", semicolon: ";", space: " ", pipe: "|", colon: ":" };
function parseTextFile(text, fileName) {
  text = text.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const meta = {}; let bodyStart = 0;
  while (bodyStart < lines.length && lines[bodyStart].startsWith("#")) {
    const m = lines[bodyStart].match(/^#([a-z ]+):(.*)$/i);
    if (m) meta[m[1].trim().toLowerCase()] = m[2].trim();
    bodyStart++;
  }
  const body = lines.slice(bodyStart).join("\n");
  const hasHeaders = Object.keys(meta).length > 0;
  const nonEmpty = lines.slice(bodyStart).filter(l => l.trim());
  const dashLines = nonEmpty.filter(l => /\s[—–-]\s/.test(l) && !l.includes("\t")).length;
  let sep;
  if (meta.separator) sep = SEP_NAMES[meta.separator.toLowerCase()] ?? meta.separator;
  else if (!hasHeaders && nonEmpty.length && dashLines / nonEmpty.length > 0.6) {
    const pairs = nonEmpty.map(splitListLine).filter(Boolean);
    return { fieldNames: ["Слово", "Перевод"], notes: pairs.map(p => ({ fields: p })), html: false };
  } else {
    const sample = nonEmpty.slice(0, 20).join("\n");
    const cnt = ch => (sample.match(new RegExp(ch === "\t" ? "\t" : "\\" + ch, "g")) || []).length;
    sep = ["\t", ";", ","].sort((a, b) => cnt(b) - cnt(a))[0];
    if (!cnt(sep)) sep = /\.csv$/i.test(fileName || "") ? "," : "\t";
  }
  const html = /^true$/i.test(meta.html || "");
  let rows = parseCSV(body, sep);
  const metaCols = {};
  for (const key of ["guid", "notetype", "deck", "tags"]) {
    const v = parseInt(meta[key + " column"], 10); if (v > 0) metaCols[key] = v - 1;
  }
  let fieldNames = meta.columns ? meta.columns.split(sep) : null;
  if (!fieldNames && !hasHeaders && rows.length > 1 && /\.csv$/i.test(fileName || "")) {
    const h = rows[0].map(s => s.trim().toLowerCase());
    if (h.some(x => /^(front|back|word|translation|term|definition|слово|перевод|вопрос|ответ|термин)$/.test(x))) { fieldNames = rows[0]; rows = rows.slice(1); }
  }
  const skip = new Set(Object.values(metaCols));
  const width = Math.max(0, ...rows.map(r => r.length));
  const keep = []; for (let i = 0; i < width; i++) if (!skip.has(i)) keep.push(i);
  const names = keep.map((i, k) => (fieldNames && fieldNames[i]) || ("Колонка " + (k + 1)));
  const notes = rows.map(r => ({
    fields: keep.map(i => { const v = (r[i] ?? "").trim(); return html ? htmlToText(v).text : v; }),
    deck: metaCols.deck !== undefined ? (r[metaCols.deck] || "").trim() : ""
  })).filter(n => n.fields.some(Boolean));
  return { fieldNames: names, notes, html };
}

/* ---------- HTML / cloze ---------- */
const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", shy: "" };
function htmlToText(s) {
  let media = false;
  let t = String(s ?? "")
    .replace(/\[sound:[^\]]*\]/g, () => { media = true; return ""; })
    .replace(/<img\b[^>]*>/gi, () => { media = true; return ""; })
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n ? String.fromCodePoint(n) : ""; }
      return ENT[e.toLowerCase()] ?? m;
    });
  t = t.split("\n").map(l => l.replace(/[ \t ]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: t, media };
}
const CLOZE_RE = /\{\{c\d+::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
const hasCloze = s => /\{\{c\d+::/.test(s);
const clozeFront = s => s.replace(CLOZE_RE, (m, a, h) => h ? "[" + h + "]" : "[…]");
const clozeBack = s => s.replace(CLOZE_RE, "$1");

/* ---------- Anki package (.apkg / .colpkg) ---------- */
function zstdDecompress(bytes, fzstd) {
  const chunks = []; let total = 0;
  const stream = new fzstd.Decompress(chunk => { chunks.push(chunk); total += chunk.length; });
  stream.push(bytes, true);
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
async function readAnkiPackage(buf, libs, onStep) {
  const step = onStep || (() => {});
  step("Распаковываю архив…");
  let zip;
  try { zip = await libs.JSZip.loadAsync(buf); } catch { throw new Error("Файл не похож на архив Anki. Экспортируйте колоду из Anki ещё раз в формате .apkg."); }
  let bytes = null, format = "";
  const f21b = zip.file("collection.anki21b"), f21 = zip.file("collection.anki21"), f2 = zip.file("collection.anki2");
  if (f21b) { bytes = zstdDecompress(await f21b.async("uint8array"), libs.fzstd); format = "anki21b"; }
  else if (f21) { bytes = await f21.async("uint8array"); format = "anki21"; }
  else if (f2) { bytes = await f2.async("uint8array"); format = "anki2"; }
  else throw new Error("В архиве нет коллекции Anki. Проверьте, что это файл .apkg или .colpkg.");
  if (bytes[18] === 2 || bytes[19] === 2) { bytes = bytes.slice(); bytes[18] = 1; bytes[19] = 1; }
  step("Читаю карточки…");
  const SQL = await libs.initSqlJs();
  const db = new SQL.Database(bytes);
  const q = sql => { try { const r = db.exec(sql); return r[0] ? r[0].values : []; } catch { return null; } };
  try {
    const crt = Number((q("SELECT crt FROM col") || [[0]])[0]?.[0] || 0);
    const deckNames = new Map();
    const dt = q("SELECT id, name FROM decks");
    if (dt) dt.forEach(([id, name]) => deckNames.set(String(id), String(name).split("\x1f").join("::")));
    else { try { Object.values(JSON.parse(q("SELECT decks FROM col")[0][0] || "{}")).forEach(d => deckNames.set(String(d.id), d.name)); } catch {} }
    const models = new Map();
    const nt = q("SELECT id, name FROM notetypes");
    if (nt) {
      nt.forEach(([id, name]) => models.set(String(id), { name: String(name), fields: [] }));
      (q("SELECT ntid, ord, name FROM fields ORDER BY ntid, ord") || []).forEach(([ntid, ord, name]) => { const m = models.get(String(ntid)); if (m) m.fields[ord] = String(name); });
    } else {
      try { Object.values(JSON.parse(q("SELECT models FROM col")[0][0] || "{}")).forEach(m => models.set(String(m.id), { name: m.name, fields: (m.flds || []).sort((a, b) => a.ord - b.ord).map(f => f.name) })); } catch {}
    }
    const notes = q("SELECT id, mid, flds FROM notes") || [];
    const cards = q("SELECT nid, did, ord, type, queue, due, ivl, factor, reps, lapses, odid, odue FROM cards ORDER BY nid, ord") || [];
    if (format === "anki2" && notes.length <= 1 && zip.file("meta") && notes.some(n => /update|обнов/i.test(String(n[2])))) {
      throw new Error("Этот файл сделан новой версией Anki, но внутри нет данных. Экспортируйте колоду ещё раз.");
    }
    const firstCard = new Map();
    for (const [nid, did, ord, type, queue, due, ivl, factor, reps, lapses, odid, odue] of cards) {
      const k = String(nid); if (firstCard.has(k)) continue;
      firstCard.set(k, { did: String(odid || did), type, queue, due: odid ? odue : due, ivl, factor, reps, lapses });
    }
    const groups = new Map(); let media = false, scheduled = 0;
    for (const [nid, mid, flds] of notes) {
      const raw = String(flds).split("\x1f");
      const conv = raw.map(htmlToText); if (conv.some(c => c.media)) media = true;
      const card = firstCard.get(String(nid)); if (!card) continue;
      const m = models.get(String(mid)) || { name: "Тип заметок", fields: [] };
      if (!groups.has(String(mid))) groups.set(String(mid), { name: m.name, fieldNames: raw.map((_, i) => m.fields[i] || "Поле " + (i + 1)), notes: [] });
      if (card.type !== 0) scheduled++;
      groups.get(String(mid)).notes.push({ fields: conv.map(c => c.text), deck: deckNames.get(card.did) || "Импорт из Anki", sched: card });
    }
    return { format, crt, media, scheduled, groups: [...groups.values()] };
  } finally { db.close(); }
}

function cardFromAnki(f, b, s, crt, now) {
  const c = newCard(f, b);
  if (!s || !s.type) return c;
  c.reps = s.reps || 0; c.lapses = s.lapses || 0;
  c.ease = s.factor > 0 ? Math.max(1.3, s.factor / 1000) : 2.5;
  if (s.type === 2) {
    const dueMs = crt ? crt * 1000 + s.due * DAY : NaN;
    c.s = 2; c.ivl = Math.max(1, s.ivl || 1);
    c.due = Number.isFinite(dueMs) ? dayStart(dueMs) : dayStart(now) + c.ivl * DAY;
  } else {
    c.s = s.type === 3 ? 3 : 1; c.ivl = s.type === 3 ? Math.max(1, s.ivl || 1) : 0; c.due = now;
  }
  return c;
}

/* mapping: {front, back:[...], cloze} per group; opts: {keepSched, mergeName, crt} */
function buildImport(groups, mappings, opts, existing) {
  const now = Date.now();
  const byDeck = new Map();
  groups.forEach((g, gi) => {
    const mp = mappings[gi]; if (!mp || mp.skip) return;
    for (const n of g.notes) {
      let f = n.fields[mp.front] || "";
      let backParts = mp.back.map(i => n.fields[i] || "").filter(Boolean);
      if (hasCloze(f)) { backParts = [clozeBack(f), ...backParts]; f = clozeFront(f); }
      const b = backParts.join("\n");
      if (!f.trim() || !b.trim()) continue;
      const deck = opts.mergeName || n.deck || opts.defaultName || "Импорт";
      if (!byDeck.has(deck)) byDeck.set(deck, []);
      byDeck.get(deck).push(opts.keepSched ? cardFromAnki(f, b, n.sched, opts.crt, now) : newCard(f, b));
    }
  });
  const result = []; let added = 0, dupes = 0;
  for (const [name, cards] of byDeck) {
    const target = existing.find(d => d.name === name);
    const seen = new Set((target ? target.cards : []).map(c => c.f + "\u0000" + c.b));
    const fresh = cards.filter(c => { const k = c.f + "\u0000" + c.b; if (seen.has(k)) { dupes++; return false; } seen.add(k); return true; });
    added += fresh.length;
    if (!fresh.length) continue;
    result.push({ name, target, cards: fresh });
  }
  return { decks: result, added, dupes };
}
/* ---------- chunked storage: one deck spread over several documents ---------- */
const CHUNK_TARGET = 150000, CHUNK_MAX = 220000;
const cardRow = c => CARD_KEYS.map(k => c[k] ?? null);
function cardFromRow(a, k) { const c = {}; CARD_KEYS.forEach((key, i) => { if (a[i] !== null && a[i] !== undefined) c[key] = a[i]; }); if (k !== undefined) c._k = k; return c; }
const enc = new TextEncoder();
const rowBytes = c => enc.encode(JSON.stringify(cardRow(c))).length + 1;
function deckMeta(d) {
  return { name: d.name || "Без названия", created: d.created || 0, newPerDay: d.newPerDay ?? DEFAULT_NEW_PER_DAY, reverse: !!d.reverse,
    typeIn: !!d.typeIn, newDay: d.newDay || "", newDone: d.newDone || 0, v: 2 };
}
function packChunks(deck) {
  const size = new Map(), bytes = new Map();
  for (const c of deck.cards) { const b = rowBytes(c); bytes.set(c, b); if (c._k !== undefined) size.set(c._k, (size.get(c._k) || 0) + b); }
  for (const [k, sz] of [...size]) {
    if (sz <= CHUNK_MAX) continue;
    let cur = sz;
    for (let i = deck.cards.length - 1; i >= 0 && cur > CHUNK_TARGET; i--) { const c = deck.cards[i]; if (c._k === k) { cur -= bytes.get(c); c._k = undefined; } }
    size.set(k, cur);
  }
  let open = size.size ? Math.max(...size.keys()) : 0, next = open + 1;
  if (!size.has(open)) size.set(open, 0);
  for (const c of deck.cards) {
    if (c._k !== undefined) continue;
    const b = bytes.get(c);
    if (size.get(open) + b > CHUNK_TARGET && size.get(open) > 0) { open = next++; size.set(open, 0); }
    c._k = open; size.set(open, size.get(open) + b);
  }
  const groups = new Map();
  for (const c of deck.cards) { if (!groups.has(c._k)) groups.set(c._k, []); groups.get(c._k).push(c); }
  return groups;
}

/* ---------- export ---------- */
function exportAnkiText(deck) {
  const cell = s => /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  return "#separator:tab\n#html:false\n#columns:Front\tBack\n" + deck.cards.map(c => cell(c.f) + "\t" + cell(c.b)).join("\n") + "\n";
}

/* ---------- stats ---------- */
function bump(stats, now, patch) {
  const k = dayKey(now); const d = stats.days[k] || (stats.days[k] = {});
  for (const [key, v] of Object.entries(patch)) d[key] = (d[key] || 0) + v;
  const keys = Object.keys(stats.days).sort();
  while (keys.length > 400) delete stats.days[keys.shift()];
}
const activity = d => d ? (d.r || 0) + (d.t || 0) : 0;
function streak(stats, now = Date.now()) {
  let t = dayStart(now), s = 0;
  if (!activity(stats.days[dayKey(t)])) t -= DAY;
  while (activity(stats.days[dayKey(t)])) { s++; t -= DAY; }
  return s;
}

/* ---------- quotes ---------- */
const QUOTES = [
  ["Пределы моего языка означают пределы моего мира.", "Людвиг Витгенштейн, «Логико-философский трактат»"],
  ["Кто не знает иностранных языков, тот ничего не знает о своём собственном.", "Иоганн Вольфганг Гёте, «Максимы и рефлексии»"],
  ["Мы изучаем языки, потому что язык — единственное, что стоит знать даже плохо.", "Като Ломб, переводчица, знавшая 16 языков"],
  ["Капля долбит камень.", "Овидий, «Письма с Понта» (Gutta cavat lapidem)"],
  ["Повторение — мать учения.", "Латинская пословица (Repetitio est mater studiorum)"],
  ["Ни дня без строчки.", "Латинское выражение, восходит к рассказу Плиния Старшего о художнике Апеллесе"],
  ["Поспешай медленно.", "Любимое изречение императора Августа, по Светонию"],
  ["Путь в тысячу ли начинается с одного шага.", "Лао-цзы, «Дао дэ цзин», глава 64"],
  ["Люди, обучая, учатся.", "Сенека, «Нравственные письма к Луцилию», письмо 7"],
  ["Карл Пятый, римский император, говаривал, что испанским языком с Богом, французским — с друзьями, немецким — с неприятелями, итальянским — с женским полом говорить прилично.", "Михаил Ломоносов, «Российская грамматика»"],
  ["Язык народа — лучший, никогда не увядающий и вечно вновь распускающийся цвет всей его духовной жизни.", "Константин Ушинский, «Родное слово»"],
  ["Мы — то, что мы делаем постоянно. Совершенство, следовательно, не действие, а привычка.", "Уилл Дюрант, пересказ мысли Аристотеля"],
  ["Ученье — свет, а неученье — тьма.", "Русская пословица"],
  ["Тише едешь — дальше будешь.", "Русская пословица"],
  ["Век живи — век учись.", "Русская пословица"],
  ["Иностранный язык есть оружие в жизненной борьбе.", "Карл Маркс, по воспоминаниям Поля Лафарга"],
  ["Если вы говорите с человеком на языке, который он понимает, вы обращаетесь к его голове. Если на его родном языке — к его сердцу.", "Приписывается Нельсону Манделе"],
  ["Владеть другим языком — значит обладать второй душой.", "Приписывается Карлу Великому"],
  ["Другой язык — это другое видение жизни.", "Приписывается Федерико Феллини"],
  ["Один язык открывает перед тобой коридор жизни. Два языка открывают каждую дверь на этом пути.", "Приписывается психолингвисту Фрэнку Смиту"],
  ["Язык — это дорожная карта культуры. Он рассказывает, откуда пришли его люди и куда они идут.", "Приписывается писательнице Рите Мэй Браун"],
  ["Сколько языков ты знаешь — столько раз ты человек.", "Приписывается Антону Чехову"],
  ["Неважно, как медленно ты идёшь, главное — не останавливаться.", "Приписывается Конфуцию"],
  ["Скажи мне — и я забуду, покажи мне — и я запомню, дай мне сделать — и я пойму.", "Приписывается Конфуцию; близкая мысль есть у философа Сюнь-цзы"],
  ["Кто перестаёт учиться, тот стар, будь ему двадцать или восемьдесят.", "Приписывается Генри Форду"],
  ["Изучая язык, вы получаете не только новые слова для вещей, но и новый способ думать о них.", "Приписывается журналистке Флоре Льюис"],
  ["Язык — это одежда мысли.", "Приписывается Сэмюэлу Джонсону"]
];
const quoteIndex = (now, shift = 0) => { const n = Math.floor(dayStart(now) / DAY) + shift; return ((n * 7) % QUOTES.length + QUOTES.length) % QUOTES.length; };

return { MIN, DAY, DEFAULT_NEW_PER_DAY, CHUNK_TARGET, uid, dayStart, dayKey, shuffle, serialize, deserialize, byteSize,
  newCard, schedule, fmtInterval, counts, nextCard, nextLearnDue, newLeft, normalize, checkAnswer,
  parseImport, parseCSV, parseTextFile, htmlToText, hasCloze, clozeFront, clozeBack, readAnkiPackage, cardFromAnki,
  buildImport, cardRow, cardFromRow, deckMeta, packChunks, exportAnkiText, bump, streak, QUOTES, quoteIndex };
})();
