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
const CARD_KEYS = ["id","f","b","s","due","ivl","ease","step","reps","lapses","intro","fs","fd","last","flag","sus"];
function serialize(deck) {
  return { ...deckMeta(deck), cards: deck.cards.map(c => CARD_KEYS.map(k => c[k] ?? null)) };
}
function deserialize(id, v) {
  return { id, ...deckMeta(v), cards: (v.cards || []).map(a => cardFromRow(a)) };
}
const byteSize = obj => new TextEncoder().encode(JSON.stringify(obj)).length;

/* ---------- study options ---------- */
const DEFAULT_OPTS = Object.freeze({
  algo: "sm2", retention: 0.9, steps: [1, 10], relearn: [10], gradIvl: 1, easyIvl: 4, maxIvl: 36500,
  newOrder: "seq", revOrder: "due", mix: "mix", maxRev: 200, learnAhead: false, dir: "fwd", leech: 8, leechAction: "flag"
});
function deckOpts(deck) {
  const o = { ...DEFAULT_OPTS, ...(deck && deck.opts) };
  if (!(deck && deck.opts && deck.opts.dir) && deck && deck.reverse) o.dir = "rev";
  o.steps = Array.isArray(o.steps) ? o.steps.filter(x => x > 0) : DEFAULT_OPTS.steps;
  o.relearn = Array.isArray(o.relearn) ? o.relearn.filter(x => x > 0) : DEFAULT_OPTS.relearn;
  o.retention = Math.min(0.99, Math.max(0.7, +o.retention || 0.9));
  o.maxIvl = Math.max(1, +o.maxIvl || 36500);
  return o;
}
function parseSteps(text) {
  const out = [];
  for (const raw of String(text).trim().split(/[\s,;]+/).filter(Boolean)) {
    const m = raw.match(/^(\d+(?:[.,]\d+)?)\s*(m|min|мин|м|h|ч|d|д)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1].replace(",", ".")), u = (m[2] || "m").toLowerCase();
    out.push(u === "h" || u === "ч" ? n * 60 : u === "d" || u === "д" ? n * 1440 : n);
  }
  return out.filter(x => x > 0);
}
const fmtSteps = a => a.map(m => m >= 1440 && m % 1440 === 0 ? m / 1440 + "д" : m >= 60 && m % 60 === 0 ? m / 60 + "ч" : m + "м").join(" ");
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/* ---------- FSRS-6 memory model (same formulas and defaults as the open-spaced-repetition reference) ---------- */
const FSRS_W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const S_MIN = 0.001, S_MAX = 36500;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const FSRS_DECAY = -FSRS_W[20], FSRS_FACTOR = Math.exp(Math.log(0.9) / FSRS_DECAY) - 1;
const fsrsR = (t, s) => Math.pow(1 + FSRS_FACTOR * t / s, FSRS_DECAY);
const fsrsInterval = (s, r) => Math.max(1, Math.round(s / FSRS_FACTOR * (Math.pow(r, 1 / FSRS_DECAY) - 1)));
const initD = g => FSRS_W[4] - Math.exp((g - 1) * FSRS_W[5]) + 1;
function fsrsStep(state, t, g) {
  const w = FSRS_W;
  if (!state) return { s: clamp(w[g - 1], S_MIN, S_MAX), d: clamp(initD(g), 1, 10) };
  const { s, d } = state;
  const r = fsrsR(t, s);
  let ns;
  if (t === 0) {
    const sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
    ns = clamp(s * (g >= 2 ? Math.max(sinc, 1) : sinc), S_MIN, S_MAX);
  } else if (g === 1) {
    const fail = clamp(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), S_MIN, S_MAX);
    ns = clamp(s / Math.exp(w[17] * w[18]), S_MIN, fail);
  } else {
    const hard = g === 2 ? w[15] : 1, easy = g === 4 ? w[16] : 1;
    ns = clamp(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hard * easy), S_MIN, S_MAX);
  }
  const nd = d + (-w[6] * (g - 3)) * (10 - d) / 9;
  return { s: ns, d: clamp(w[7] * initD(4) + (1 - w[7]) * nd, 1, 10) };
}
function memoryOf(card) {
  if (card.fs > 0 && card.fd > 0) return { s: card.fs, d: card.fd };
  if (!card.reps || card.s === 0) return null;
  return { s: card.s === 2 ? Math.max(0.5, card.ivl || 1) : FSRS_W[2], d: clamp(13.3 - 3.5 * (card.ease || 2.5), 1, 10) };
}
function recallChance(card, now = Date.now()) {
  const m = memoryOf(card); if (!m || !card.last && card.s !== 2) return null;
  const since = card.last || (card.due - (card.ivl || 1) * DAY);
  return fsrsR(Math.max(0, (dayStart(now) - dayStart(since)) / DAY), m.s);
}

/* ---------- scheduler ---------- */
/* card.s: 0 new, 1 learning, 2 review, 3 relearning */
function newCard(f, b) { return { id: uid(), f, b, s: 0, due: 0, ivl: 0, ease: 2.5, step: 0, reps: 0, lapses: 0 }; }
function fuzz(ivl) { if (ivl < 3) return ivl; const r = Math.max(1, Math.round(ivl * 0.05)); return ivl + Math.round((Math.random() * 2 - 1) * r); }
const dueInDays = (days, now) => dayStart(now) + days * DAY;
const MIN_PER_DAY = 1440;

function elapsedDays(card, now) {
  if (card.last) return Math.max(0, Math.round((dayStart(now) - dayStart(card.last)) / DAY));
  if (card.s === 2) return Math.max(0, (card.ivl || 0) + Math.floor((dayStart(now) - card.due) / DAY));
  return 0;
}
function reviewIntervals(card, now, o) {
  const late = Math.max(0, Math.floor((dayStart(now) - card.due) / DAY));
  const mem = memoryOf(card), t = elapsedDays(card, now);
  let iv;
  if (o.algo === "fsrs" && mem) {
    iv = [2, 3, 4].map(g => fsrsInterval(fsrsStep(mem, t, g).s, o.retention));
  } else {
    const e = card.ease || 2.5, cur = card.ivl || 1;
    iv = [cur * 1.2, (cur + late / 2) * e, (cur + late) * e * 1.3].map(x => Math.round(x));
    iv[0] = Math.max(iv[0], cur + 1);
  }
  iv[1] = Math.max(iv[1], iv[0] + 1);
  iv[2] = Math.max(iv[2], iv[1] + 1);
  return iv.map(x => Math.min(o.maxIvl, Math.max(1, x)));
}

function schedule(card, rating, now, preview, optsIn) {
  const o = optsIn || DEFAULT_OPTS;
  const c = { ...card };
  const t = elapsedDays(card, now);
  const mem = memoryOf(card);
  const nextMem = g => fsrsStep(mem, mem ? t : 0, g);
  const graduate = (g, base) => {
    let ivl;
    if (o.algo === "fsrs") {
      const good = fsrsInterval(nextMem(3).s, o.retention);
      ivl = g === 4 ? Math.max(fsrsInterval(nextMem(4).s, o.retention), good + 1) : good;
      if (base) ivl = Math.max(ivl, g === 4 ? base + 1 : base);
    } else ivl = g === 4 ? (base ? Math.max(o.easyIvl, base + 1) : o.easyIvl) : (base || o.gradIvl);
    c.s = 2; c.step = 0; c.ivl = Math.min(o.maxIvl, Math.max(1, ivl)); c.due = dueInDays(c.ivl, now);
  };
  if (c.s === 2) {
    if (rating === 1) {
      c.lapses = (c.lapses || 0) + 1; c.ease = Math.max(1.3, (c.ease || 2.5) - 0.2);
      c.ivl = o.algo === "fsrs" ? fsrsInterval(nextMem(1).s, o.retention) : Math.max(1, Math.round(c.ivl * 0.2));
      if (o.relearn.length) { c.s = 3; c.step = 0; c.due = now + o.relearn[0] * MIN; }
      else c.due = dueInDays(c.ivl, now);
    } else {
      const iv = reviewIntervals(card, now, o), ivl = iv[rating - 2];
      if (rating === 2) c.ease = Math.max(1.3, (c.ease || 2.5) - 0.15);
      if (rating === 4) c.ease = (c.ease || 2.5) + 0.15;
      c.ivl = preview ? ivl : Math.min(o.maxIvl, fuzz(ivl)); c.due = dueInDays(c.ivl, now);
    }
  } else {
    const relearn = c.s === 3;
    const steps = relearn ? o.relearn : o.steps;
    if (c.s === 0) { c.s = 1; c.step = 0; if (!preview) c.intro = now; }
    const base = relearn ? Math.max(1, c.ivl || 1) : 0;
    if (!steps.length) { if (rating === 1) { c.due = now + MIN; } else graduate(rating === 4 ? 4 : 3, base); }
    else if (rating === 1) { c.step = 0; c.due = now + steps[0] * MIN; }
    else if (rating === 2) {
      const m = c.step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[Math.min(c.step, steps.length - 1)] * 1.5;
      c.due = now + Math.min(m, steps[Math.min(c.step, steps.length - 1)] + MIN_PER_DAY) * MIN;
    } else if (rating === 3) {
      if (c.step + 1 < steps.length) { c.step++; c.due = now + steps[c.step] * MIN; }
      else graduate(3, base);
    } else graduate(4, base);
  }
  if (!preview) {
    const m = nextMem(rating); c.fs = +m.s.toFixed(4); c.fd = +m.d.toFixed(4); c.last = now;
    c.reps = (c.reps || 0) + 1;
  }
  return c;
}
function fmtInterval(next, now) {
  if (next.s === 1 || next.s === 3) {
    const m = Math.round((next.due - now) / MIN);
    return m < 60 ? Math.max(1, m) + " мин" : m < 1440 ? Math.round(m / 60) + " ч" : Math.round(m / 1440) + " д";
  }
  const d = next.ivl;
  if (d < 30) return d + " д";
  if (d < 365) return (d / 30).toFixed(1).replace(".0", "") + " мес";
  return (d / 365).toFixed(1).replace(".0", "") + " г";
}

/* ---------- queues ---------- */
const isLearning = c => c.s === 1 || c.s === 3;
const newLeft = (deck, now = Date.now()) => Math.max(0, (deck.newPerDay ?? DEFAULT_NEW_PER_DAY) - (deck.newDay === dayKey(now) ? deck.newDone : 0));
const revLeft = (deck, now = Date.now()) => Math.max(0, deckOpts(deck).maxRev - (deck.revDay === dayKey(now) ? deck.revDone || 0 : 0));
function counts(deck, now = Date.now()) {
  const end = dayStart(now) + DAY;
  let n = 0, l = 0, r = 0, sus = 0;
  for (const c of deck.cards) {
    if (c.sus) { sus++; continue; }
    if (c.s === 0) n++;
    else if (isLearning(c)) { if (c.due < end) l++; }
    else if (c.due < end) r++;
  }
  return { n: Math.min(n, newLeft(deck, now)), l, r: Math.min(r, revLeft(deck, now)), total: deck.cards.length, newTotal: n, sus };
}
function cardDirection(deck, card) {
  const dir = deckOpts(deck).dir;
  if (dir === "both") return (hash(card.id) + (card.reps || 0)) % 2 ? "rev" : "fwd";
  return dir === "rev" ? "rev" : "fwd";
}
function nextCard(deck, now = Date.now()) {
  const o = deckOpts(deck), end = dayStart(now) + DAY, today = dayKey(now);
  const active = deck.cards.filter(c => !c.sus);
  const byDue = (a, b) => a.due - b.due;
  const learnNow = active.filter(c => isLearning(c) && c.due <= now).sort(byDue);
  if (learnNow.length) return learnNow[0];
  let reviews = revLeft(deck, now) > 0 ? active.filter(c => c.s === 2 && c.due < end) : [];
  reviews = o.revOrder === "random" ? reviews.sort((a, b) => hash(a.id + today) - hash(b.id + today)) : reviews.sort(byDue);
  const nl = newLeft(deck, now);
  let news = [];
  if (nl > 0) {
    news = active.filter(c => c.s === 0);
    if (o.newOrder === "random") news.sort((a, b) => hash(a.id) - hash(b.id));
    else if (o.newOrder === "reverse") news.reverse();
  }
  if (reviews.length && news.length) {
    if (o.mix === "rev_first") return reviews[0];
    if (o.mix === "new_first") return news[0];
    const doneToday = (deck.newDay === today ? deck.newDone : 0) + (deck.revDay === today ? deck.revDone || 0 : 0);
    const every = Math.max(2, Math.floor(reviews.length / Math.min(news.length, nl)) + 1);
    return doneToday % every === every - 1 ? news[0] : reviews[0];
  }
  if (reviews.length) return reviews[0];
  if (news.length) return news[0];
  if (o.learnAhead) { const ahead = active.filter(c => isLearning(c) && c.due <= now + LEARN_AHEAD).sort(byDue); if (ahead.length) return ahead[0]; }
  return null;
}
function nextLearnDue(deck) {
  const l = deck.cards.filter(c => !c.sus && isLearning(c)).sort((a, b) => a.due - b.due);
  return l.length ? l[0].due : null;
}
function earliestLearning(deck) { return deck.cards.filter(c => !c.sus && isLearning(c)).sort((a, b) => a.due - b.due)[0] || null; }
function wordStatus(c) {
  if (c.sus) return "sus";
  if (c.s === 0) return "new";
  if (isLearning(c)) return "learn";
  return (c.ivl || 0) >= 21 ? "known" : "review";
}
const isHard = c => !!c.flag || (c.lapses || 0) >= 3;

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
    typeIn: !!d.typeIn, newDay: d.newDay || "", newDone: d.newDone || 0, revDay: d.revDay || "", revDone: d.revDone || 0,
    lang: d.lang || "en", opts: d.opts && typeof d.opts === "object" ? { ...d.opts } : {}, v: 2 };
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

/* ---------- English word forms ---------- */
const IRREGULAR = Object.fromEntries(("arise arose arisen|awake awoke awoken|bear bore borne|beat beat beaten|become became become|begin began begun|" +
  "bend bent bent|bet bet bet|bid bid bid|bind bound bound|bite bit bitten|bleed bled bled|blow blew blown|break broke broken|breed bred bred|" +
  "bring brought brought|broadcast broadcast broadcast|build built built|burn burned/burnt burned/burnt|burst burst burst|buy bought bought|" +
  "cast cast cast|catch caught caught|choose chose chosen|cling clung clung|come came come|cost cost cost|creep crept crept|cut cut cut|" +
  "deal dealt dealt|dig dug dug|do did done|draw drew drawn|dream dreamed/dreamt dreamed/dreamt|drink drank drunk|drive drove driven|" +
  "dwell dwelt/dwelled dwelt/dwelled|eat ate eaten|fall fell fallen|feed fed fed|feel felt felt|fight fought fought|find found found|flee fled fled|" +
  "fly flew flown|forbid forbade forbidden|forecast forecast forecast|foresee foresaw foreseen|forget forgot forgotten|forgive forgave forgiven|" +
  "freeze froze frozen|get got got/gotten|give gave given|go went gone|grind ground ground|grow grew grown|hang hung hung|have had had|" +
  "hear heard heard|hide hid hidden|hit hit hit|hold held held|hurt hurt hurt|keep kept kept|kneel knelt/kneeled knelt/kneeled|know knew known|" +
  "lay laid laid|lead led led|lean leaned/leant leaned/leant|leap leaped/leapt leaped/leapt|learn learned/learnt learned/learnt|leave left left|" +
  "lend lent lent|let let let|lie lay lain|light lit/lighted lit/lighted|lose lost lost|make made made|mean meant meant|meet met met|" +
  "mislead misled misled|mistake mistook mistaken|misunderstand misunderstood misunderstood|mow mowed mown/mowed|overcome overcame overcome|" +
  "overtake overtook overtaken|pay paid paid|prove proved proven/proved|put put put|quit quit quit|read read read|rewrite rewrote rewritten|" +
  "ride rode ridden|ring rang rung|rise rose risen|run ran run|say said said|see saw seen|seek sought sought|sell sold sold|send sent sent|" +
  "set set set|sew sewed sewn/sewed|shake shook shaken|shine shone shone|shoot shot shot|show showed shown|shrink shrank shrunk|shut shut shut|" +
  "sing sang sung|sink sank sunk|sit sat sat|sleep slept slept|slide slid slid|sling slung slung|slit slit slit|smell smelled/smelt smelled/smelt|" +
  "sow sowed sown/sowed|speak spoke spoken|speed sped sped|spell spelled/spelt spelled/spelt|spend spent spent|spill spilled/spilt spilled/spilt|" +
  "spin spun spun|spit spat spat|split split split|spoil spoiled/spoilt spoiled/spoilt|spread spread spread|spring sprang sprung|stand stood stood|" +
  "steal stole stolen|stick stuck stuck|sting stung stung|stink stank stunk|stride strode stridden|strike struck struck|strive strove striven|" +
  "swear swore sworn|sweep swept swept|swell swelled swollen|swim swam swum|swing swung swung|take took taken|teach taught taught|tear tore torn|" +
  "tell told told|think thought thought|throw threw thrown|tread trod trodden|understand understood understood|undertake undertook undertaken|" +
  "undo undid undone|uphold upheld upheld|upset upset upset|wake woke woken|wear wore worn|weave wove woven|weep wept wept|win won won|" +
  "wind wound wound|withdraw withdrew withdrawn|withstand withstood withstood|wring wrung wrung|write wrote written").split("|").map(r => { const [b, p, pp] = r.split(" "); return [b, { past: p, pp }]; }));
const MODALS = new Set(["can", "could", "may", "might", "must", "shall", "should", "will", "would", "ought", "need to"]);
const DOUBLE_FINAL = new Set(["admit", "commit", "occur", "prefer", "refer", "regret", "permit", "omit", "submit", "control", "patrol", "equip", "compel", "expel", "propel", "transfer", "confer", "deter", "excel", "rebel", "abhor", "incur", "recur", "acquit", "begin", "forget", "upset"]);
const isVowel = ch => "aeiou".includes(ch);
const syllables = w => (w.match(/[aeiouy]+/g) || []).length;
function doublesFinal(w) {
  if (DOUBLE_FINAL.has(w)) return true;
  return syllables(w) === 1 && /[^aeiou][aeiou][^aeiouwxy]$/.test(w) && !/^(qu)/.test(w.slice(-4, -2));
}
function ingForm(w) {
  if (w === "be") return "being";
  if (/ie$/.test(w)) return w.slice(0, -2) + "ying";
  if (/[^eoy]e$/.test(w) && !/(ee|ye|oe)$/.test(w)) return w.slice(0, -1) + "ing";
  if (/c$/.test(w) && ["panic", "picnic", "traffic", "mimic"].includes(w)) return w + "king";
  return (doublesFinal(w) ? w + w.slice(-1) : w) + "ing";
}
function edForm(w) {
  if (/e$/.test(w)) return w + "d";
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + "ied";
  if (["panic", "picnic", "traffic", "mimic"].includes(w)) return w + "ked";
  return (doublesFinal(w) ? w + w.slice(-1) : w) + "ed";
}
function sForm(w) {
  if (w === "have") return "has";
  if (w === "be") return "is";
  if (/(s|x|z|ch|sh|o)$/.test(w) && !/(oo)$/.test(w)) return w + "es";
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + "ies";
  return w + "s";
}
function englishVerb(raw, translation) {
  let text = String(raw).toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, " ").split(/[,;/\n]/)[0].replace(/[^a-z' -]/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/^to /, "");
  if (!text) return null;
  const [head, ...rest] = text.split(" ");
  if (MODALS.has(text) || MODALS.has(head)) return { modal: true, base: text };
  const tail = rest.length ? " " + rest.join(" ") : "";
  const irr = head === "lie" && /лгать|врать|солгать|соврать/i.test(translation || "") ? null : IRREGULAR[head];
  const first = s => s.split("/")[0];
  const v = head === "be"
    ? { base: "be", past: "was/were", pp: "been", ing: "being", s: "is", irregular: true }
    : { base: head, past: irr ? irr.past : edForm(head), pp: irr ? irr.pp : edForm(head), ing: ingForm(head), s: sForm(head), irregular: !!irr };
  v.tail = tail;
  const P = ["I", "he", "they"];
  const be = ["am", "is", "are"], bePast = ["was", "was", "were"], have = ["have", "has", "have"], doAux = ["do", "does", "do"];
  const isBe = head === "be";
  const make = (i, kind, aux, rest2) => {
    const s = P[i];
    if (kind === "aff") return `${s} ${aux ? aux + " " : ""}${rest2}${tail}`;
    if (kind === "neg") return `${s} ${aux} not${rest2 ? " " + rest2 : ""}${tail}`;
    const q = `${aux[0].toUpperCase()}${aux.slice(1)} ${s} ${rest2}`.replace(/\s+$/, "");
    return q + tail + "?";
  };
  const chain = (auxFirst, more) => (i, kind) => {
    const a = typeof auxFirst === "function" ? auxFirst(i) : auxFirst;
    return make(i, kind, a, more);
  };
  const simplePresent = (i, kind) => {
    if (isBe) return kind === "aff" ? `${P[i]} ${be[i]}${tail}` : kind === "neg" ? `${P[i]} ${be[i]} not${tail}` : `${be[i][0].toUpperCase() + be[i].slice(1)} ${P[i]}${tail}?`;
    if (kind === "aff") return `${P[i]} ${i === 1 ? v.s : v.base}${tail}`;
    return make(i, kind, doAux[i], v.base);
  };
  const simplePast = (i, kind) => {
    if (isBe) return kind === "aff" ? `${P[i]} ${bePast[i]}${tail}` : kind === "neg" ? `${P[i]} ${bePast[i]} not${tail}` : `${bePast[i][0].toUpperCase() + bePast[i].slice(1)} ${P[i]}${tail}?`;
    if (kind === "aff") return `${P[i]} ${first(v.past)}${tail}`;
    return make(i, kind, "did", v.base);
  };
  const T = (id, name, ru, hint, fn) => ({ id, name, ru, hint, forms: kind => [0, 1, 2].map(i => fn(i, kind)) });
  v.groups = [
    { name: "Будущее", tenses: [
      T("fs", "Future Simple", "Решение в момент речи, прогноз, обещание", "tomorrow, next week, soon", chain("will", v.base)),
      T("going", "be going to", "Планы и намерения; прогноз по явным признакам", "tonight, this weekend", chain(i => be[i], "going to " + v.base)),
      T("fc", "Future Continuous", "Будет происходить в определённый момент в будущем", "this time tomorrow, at 5 pm tomorrow", chain("will", "be " + v.ing)),
      T("fp", "Future Perfect", "Будет завершено к моменту в будущем", "by tomorrow, by the time", chain("will", "have " + first(v.pp))),
      T("fpc", "Future Perfect Continuous", "Будет длиться уже какое-то время к моменту в будущем", "for two hours by then", chain("will", "have been " + v.ing)),
      T("fip", "Future in the Past", "Будущее с точки зрения прошлого: «сказал, что сделает»", "He said he would…", chain("would", v.base))
    ] },
    { name: "Настоящее", tenses: [
      T("ps", "Present Simple", "Факты, привычки, расписания", "always, usually, every day", simplePresent),
      T("pc", "Present Continuous", "Происходит сейчас; договорённость на ближайшее будущее", "now, at the moment, tomorrow (план)", chain(i => be[i], v.ing)),
      T("pp", "Present Perfect", "Результат к настоящему моменту, жизненный опыт", "already, yet, ever, just", chain(i => have[i], first(v.pp))),
      T("ppc", "Present Perfect Continuous", "Началось в прошлом и длится до сих пор", "for, since, all day", chain(i => have[i], "been " + v.ing))
    ] },
    { name: "Прошедшее", tenses: [
      T("pas", "Past Simple", "Завершённое действие в прошлом", "yesterday, ago, last year", simplePast),
      T("pac", "Past Continuous", "Длилось в определённый момент прошлого", "at 5 pm yesterday, while", chain(i => bePast[i], v.ing)),
      T("pap", "Past Perfect", "Случилось раньше другого события в прошлом", "before, by the time, already", chain("had", first(v.pp))),
      T("papc", "Past Perfect Continuous", "Длилось какое-то время до момента в прошлом", "for two hours before", chain("had", "been " + v.ing))
    ] }
  ];
  return v;
}
const IRREGULAR_PLURAL = { man: "men", woman: "women", child: "children", person: "people", tooth: "teeth", foot: "feet", mouse: "mice", goose: "geese",
  ox: "oxen", sheep: "sheep", fish: "fish", deer: "deer", series: "series", species: "species", life: "lives", knife: "knives", wife: "wives",
  leaf: "leaves", half: "halves", wolf: "wolves", shelf: "shelves", thief: "thieves", calf: "calves", loaf: "loaves", potato: "potatoes",
  tomato: "tomatoes", hero: "heroes", echo: "echoes", cactus: "cacti", analysis: "analyses", crisis: "crises", phenomenon: "phenomena", criterion: "criteria" };
function englishPlural(raw) {
  const w = String(raw).toLowerCase().replace(/^(a|an|the) /, "").trim();
  if (!/^[a-z]+$/.test(w)) return null;
  if (IRREGULAR_PLURAL[w]) return { plural: IRREGULAR_PLURAL[w], irregular: true };
  if (/(s|x|z|ch|sh)$/.test(w)) return { plural: w + "es" };
  if (/[^aeiou]y$/.test(w)) return { plural: w.slice(0, -1) + "ies" };
  return { plural: w + "s" };
}
const RU_VERB = /^(\S+)(ть|ться|чь|чься|ти|тись)$/i;
function looksLikeVerb(card) {
  const f = String(card.f || "").trim().toLowerCase();
  if (/^to\s+\S/.test(f)) return true;
  const head = f.split(/\s+/)[0];
  if (IRREGULAR[head] && f.split(/\s+/).length <= 3) return true;
  const ru = String(card.b || "").trim().toLowerCase().split(/[\s,;(]/)[0];
  return RU_VERB.test(ru);
}

/* ---------- Wiktionary ---------- */
const LANGS = { en: "English", nl: "Dutch", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese", sv: "Swedish", pl: "Polish", tr: "Turkish", ru: "Russian" };
const LANG_RU = { en: "Английский", nl: "Нидерландский", de: "Немецкий", fr: "Французский", es: "Испанский", it: "Итальянский", pt: "Португальский", sv: "Шведский", pl: "Польский", tr: "Турецкий", other: "Другой" };
const POS_RU = { Verb: "глагол", Noun: "существительное", Adjective: "прилагательное", Adverb: "наречие", Pronoun: "местоимение", Preposition: "предлог",
  Conjunction: "союз", Interjection: "междометие", Phrase: "фраза", Idiom: "идиома", Determiner: "определитель", Numeral: "числительное", Article: "артикль",
  Particle: "частица", "Proper noun": "имя собственное", Prefix: "приставка", Suffix: "суффикс", Proverb: "пословица", "Prepositional phrase": "предложная фраза" };
function lookupWord(card) {
  return String(card.f || "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ").split(/[,;/\n]/)[0].replace(/^\s*to\s+/i, "").replace(/^(the|a|an|de|het|een|der|die|das|le|la|les|el|los|las|il|lo)\s+/i, "").trim();
}
function parseWiktDefinitions(json, lang) {
  const list = (json && json[lang]) || [];
  return list.map(e => ({
    pos: e.partOfSpeech, posRu: POS_RU[e.partOfSpeech] || e.partOfSpeech,
    defs: (e.definitions || []).map(d => ({
      text: htmlToText(d.definition).text,
      examples: (d.parsedExamples && d.parsedExamples.length ? d.parsedExamples.map(x => htmlToText(x.example).text) : (d.examples || []).map(x => htmlToText(x).text)).filter(Boolean)
    })).filter(d => d.text)
  })).filter(e => e.defs.length);
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

return { englishVerb, englishPlural, looksLikeVerb, LANGS, LANG_RU, lookupWord, parseWiktDefinitions, DEFAULT_OPTS, deckOpts, parseSteps, fmtSteps, hash, fsrsR, recallChance, memoryOf, reviewIntervals, isLearning, revLeft,
  cardDirection, earliestLearning, wordStatus, isHard, MIN, DAY, DEFAULT_NEW_PER_DAY, CHUNK_TARGET, uid, dayStart, dayKey, shuffle, serialize, deserialize, byteSize,
  newCard, schedule, fmtInterval, counts, nextCard, nextLearnDue, newLeft, normalize, checkAnswer,
  parseImport, parseCSV, parseTextFile, htmlToText, hasCloze, clozeFront, clozeBack, readAnkiPackage, cardFromAnki,
  buildImport, cardRow, cardFromRow, deckMeta, packChunks, exportAnkiText, bump, streak, QUOTES, quoteIndex };
})();
