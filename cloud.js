window.SlovnikCloud = (() => {
"use strict";
const cfg = window.SLOVNIK_CONFIG || {};
const enabled = !!(cfg.supabaseUrl && cfg.supabaseKey && window.supabase);
const MODE_KEY = "slovnik-mode";
let sb = null, user = null;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch { return false; } };
const here = () => location.origin + location.pathname;

/* ---------- data: a document store over one Postgres table ---------- */
function makeDb(uid) {
  const root = "data/users/" + uid + "/";
  const rel = p => p.startsWith(root) ? p.slice(root.length) : p;
  const CACHE = "slovnik-cache-" + uid;
  const rows = new Map();
  const subs = new Set();
  let synced = false, syncing = null, cacheTimer = null;
  try { const c = JSON.parse(lsGet(CACHE) || "null"); if (c) for (const [k, v] of Object.entries(c)) rows.set(k, v); } catch {}
  const fail = (e, fallback = "unavailable") => {
    const status = e && (e.status || e.statusCode);
    return { code: status === 413 ? "invalid_argument" : fallback, message: String((e && e.message) || e) };
  };
  function saveCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => { if (!lsSet(CACHE, JSON.stringify(Object.fromEntries(rows)))) lsSet(CACHE, null); }, 1500);
  }
  function deliver(sub, fromCache) {
    const meta = { fromCache, hasPendingWrites: false };
    if (sub.kind === "doc") {
      const r = rows.get(sub.path);
      sub.next({ id: sub.path.split("/").pop(), exists: !!r, data: () => r ? r.data : undefined, metadata: meta });
    } else {
      const docs = [];
      for (const [path, r] of rows) {
        if (!path.startsWith(sub.prefix) || path.indexOf("/", sub.prefix.length) !== -1) continue;
        docs.push({ id: path.slice(sub.prefix.length), exists: true, data: () => r.data, metadata: meta });
      }
      docs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      sub.next({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta });
    }
  }
  const notify = fromCache => subs.forEach(s => deliver(s, fromCache));
  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const listed = new Map();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from("docs").select("path,updated_at").eq("user_id", uid).order("path").range(from, from + 999);
        if (error) throw fail(error);
        data.forEach(r => listed.set(r.path, r.updated_at));
        if (data.length < 1000) break;
      }
      const stale = [...listed].filter(([p, t]) => !rows.has(p) || rows.get(p).t !== t).map(([p]) => p);
      for (let i = 0; i < stale.length; i += 50) {
        const { data, error } = await sb.from("docs").select("path,data,updated_at").eq("user_id", uid).in("path", stale.slice(i, i + 50));
        if (error) throw fail(error);
        data.forEach(r => rows.set(r.path, { data: r.data, t: r.updated_at }));
      }
      for (const p of [...rows.keys()]) if (!listed.has(p) && !rows.get(p).local) rows.delete(p);
      synced = true; saveCache(); notify(false);
    })();
    try { await syncing; } finally { syncing = null; }
  }
  const trySync = () => sync().catch(() => {});
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") trySync(); });
  window.addEventListener("online", trySync);
  setInterval(() => { if (document.visibilityState === "visible") trySync(); }, 120000);
  setTimeout(trySync, 0);
  if (rows.size) setTimeout(() => notify(true), 0);

  function subscribe(sub, next, error) {
    sub.next = next; subs.add(sub);
    if (synced) deliver(sub, false);
    return () => subs.delete(sub);
  }
  const docRef = path => {
    const r = rel(path);
    return {
      id: r.split("/").pop(), path,
      async get() { return { id: r.split("/").pop(), exists: rows.has(r), data: () => rows.get(r)?.data, metadata: { fromCache: !synced, hasPendingWrites: false } }; },
      async set(data) {
        const t = new Date().toISOString();
        rows.set(r, { data, t, local: true }); notify(!synced);
        const { error } = await sb.from("docs").upsert({ user_id: uid, path: r, data, updated_at: t }, { onConflict: "user_id,path" });
        if (error) throw fail(error);
        const cur = rows.get(r); if (cur && cur.t === t) delete cur.local;
        saveCache();
      },
      async delete() {
        rows.delete(r); notify(!synced);
        const { error } = await sb.from("docs").delete().eq("user_id", uid).eq("path", r);
        if (error) throw fail(error);
        saveCache();
      },
      onSnapshot(next, error) { return subscribe({ kind: "doc", path: r }, next, error); }
    };
  };
  const colRef = path => {
    const prefix = rel(path).replace(/\/?$/, "/");
    return { path, doc: id => docRef(path + "/" + id), onSnapshot(next, error) { return subscribe({ kind: "col", prefix }, next, error); } };
  };
  return { doc: docRef, collection: colRef };
}

/* ---------- auth screens ---------- */
const ERRORS = [
  [/invalid login credentials/i, "Неверная почта или пароль."],
  [/email not confirmed/i, "Почта ещё не подтверждена. Откройте письмо со ссылкой и перейдите по ней."],
  [/already registered|already been registered|user already exists/i, "Аккаунт с этой почтой уже есть. Войдите или восстановите пароль."],
  [/password should be at least|weak password|password is too/i, "Пароль слишком короткий или простой: нужно не меньше 6 символов."],
  [/rate limit|too many/i, "Слишком много попыток. Подождите немного и попробуйте снова."],
  [/invalid.*email|email.*invalid|unable to validate email/i, "Проверьте адрес почты."],
  [/failed to fetch|network|load failed/i, "Нет связи с сервером. Проверьте интернет."],
  [/signups not allowed|signup is disabled/i, "Регистрация новых аккаунтов выключена в настройках сервера."]
];
const explain = e => { const m = String((e && e.message) || e || ""); const hit = ERRORS.find(([re]) => re.test(m)); return hit ? hit[1] : "Не получилось: " + m; };

function renderAuth(app, mode, msg, done) {
  const syncEl = document.getElementById("sync"); if (syncEl) syncEl.textContent = "";
  const titles = { in: "Вход", up: "Новый аккаунт", reset: "Восстановление пароля", newpass: "Новый пароль", sent: "Проверьте почту" };
  let html = `<section class="panel" style="max-width:420px;margin:24px auto 0;width:100%">
    <h1>${titles[mode]}</h1>`;
  if (msg) html += `<p class="notice${msg.bad ? " warn" : ""}">${esc(msg.text)}</p>`;
  if (mode === "sent") {
    html += `<p class="muted">Письмо придёт в течение пары минут. Если его нет, загляните в «Спам».</p><button class="btn ghost" data-a="in">Ко входу</button>`;
  } else {
    html += `<form id="auth-form" class="panel" style="padding:0;border:0;gap:12px">
      ${mode !== "newpass" ? `<label>Почта<input id="au-email" type="email" autocomplete="email" required></label>` : ""}
      ${mode !== "reset" ? `<label>Пароль<input id="au-pass" type="password" minlength="6" autocomplete="${mode === "in" ? "current-password" : "new-password"}" required></label>` : ""}
      <button class="btn" type="submit" id="au-go">${mode === "in" ? "Войти" : mode === "up" ? "Создать аккаунт" : mode === "reset" ? "Прислать ссылку" : "Сохранить пароль"}</button></form>
      <div class="row" style="gap:8px">
        ${mode === "in" ? `<button class="chip" data-a="up">Создать аккаунт</button><button class="chip" data-a="reset">Забыли пароль?</button>` : mode !== "newpass" ? `<button class="chip" data-a="in">У меня уже есть аккаунт</button>` : ""}
      </div>`;
  }
  html += `</section>${mode !== "newpass" ? `<p class="muted small" style="text-align:center">или <button class="chip" data-a="local">продолжить без аккаунта</button><br>колоды будут храниться только в этом браузере</p>` : ""}`;
  app.innerHTML = html;
  app.querySelectorAll("[data-a]").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.a === "local") { lsSet(MODE_KEY, "local"); done(null); } else renderAuth(app, b.dataset.a, null, done);
  }));
  const form = document.getElementById("auth-form"); if (!form) return;
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = document.getElementById("au-go"); btn.disabled = true;
    const email = document.getElementById("au-email")?.value.trim(), password = document.getElementById("au-pass")?.value;
    try {
      if (mode === "in") {
        const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
      } else if (mode === "up") {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: here() } }); if (error) throw error;
        if (!data.session) return renderAuth(app, "sent", { text: "Мы отправили письмо на " + email + ". Перейдите по ссылке из него, чтобы подтвердить почту, и вы вернётесь сюда уже со входом." }, done);
      } else if (mode === "reset") {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: here() }); if (error) throw error;
        return renderAuth(app, "sent", { text: "Если аккаунт с адресом " + email + " существует, на него придёт ссылка для смены пароля." }, done);
      } else if (mode === "newpass") {
        const { error } = await sb.auth.updateUser({ password }); if (error) throw error;
        const { data } = await sb.auth.getSession(); if (data.session) { user = data.session.user; return done(user); }
      }
    } catch (err) { renderAuth(app, mode, { text: explain(err), bad: true }, done); }
  });
}

async function start(app) {
  if (!enabled) return null;
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  let recovery = /type=recovery/.test(location.hash);
  const result = await new Promise(resolve => {
    let finished = false;
    const done = u => { if (finished) return; finished = true; resolve(u); };
    sb.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") { recovery = true; setTimeout(() => renderAuth(app, "newpass", { text: "Придумайте новый пароль." }, done), 0); return; }
      if (event === "SIGNED_IN" && session && !recovery) { user = session.user; setTimeout(() => done(user), 0); }
      if (event === "SIGNED_OUT") user = null;
    });
    sb.auth.getSession().then(({ data }) => {
      if (/error_description=/.test(location.hash)) {
        const p = new URLSearchParams(location.hash.slice(1));
        history.replaceState(null, "", here());
        return renderAuth(app, "in", { text: "Ссылка из письма устарела или уже использована. Войдите или запросите новую.", bad: true, raw: p.get("error_description") }, done);
      }
      if (recovery) return;
      if (data.session) { user = data.session.user; return done(user); }
      if (lsGet(MODE_KEY) === "local") return done(null);
      renderAuth(app, "in", null, done);
    }).catch(() => renderAuth(app, "in", { text: "Нет связи с сервером. Проверьте интернет.", bad: true }, done));
  });
  if (location.hash && /access_token|type=/.test(location.hash)) history.replaceState(null, "", here());
  if (!result) return null;
  lsSet(MODE_KEY, null);
  app.innerHTML = `<div class="empty"><h2>Загружаю ваши колоды…</h2></div>`;
  return { db: makeDb(result.id), userId: result.id };
}

return {
  enabled, start,
  account: () => user ? { email: user.email } : null,
  wantLogin() { lsSet(MODE_KEY, null); location.reload(); },
  async signOut() { const id = user && user.id; try { await sb.auth.signOut(); } catch {} if (id) lsSet("slovnik-cache-" + id, null); lsSet(MODE_KEY, null); location.reload(); }
};
})();
