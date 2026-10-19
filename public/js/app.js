// IxGoo Courier & Logistics — app statica: Firebase Authentication + Firestore + Hosting.
// Ruoli (campo "role" in users/{uid}): cliente, admin, corriere. Le regole di sicurezza
// in firestore.rules decidono chi può leggere e modificare cosa.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendEmailVerification, sendPasswordResetEmail, reauthenticateWithCredential,
  EmailAuthProvider, updatePassword,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, query, where, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { LANGS, DEFAULT_LANG, RTL, TR } from "./i18n.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

const STATUS = ["in_attesa", "confermata", "consegnata", "annullata"];
// questi indirizzi diventano admin alla registrazione (stessa lista in firestore.rules)
const ADMIN_EMAILS = ["ixgoo@outlook.gr", "pierpaolomurgioni@gmail.com"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9 ./()-]{6,20}$/;
const ZIP_RE = /^[A-Za-z0-9 -]{3,10}$/;

const state = { user: null, profile: null, profileLoaded: false, ready: false, lang: storedLang() };
let unsubs = [];
let pendingFlash = null;
let profileUnsub = null;

// ------------------------------------------------------------------ utilità

function storedLang() {
  try {
    const l = localStorage.getItem("ixgoo_lang");
    if (l && LANGS[l]) return l;
  } catch (e) { /* storage non disponibile */ }
  return null;
}

function lang() {
  return state.lang || (state.profile && LANGS[state.profile.lang] && state.profile.lang) || DEFAULT_LANG;
}

function t(key, params) {
  let s = (TR[lang()] && TR[lang()][key]) ?? TR.en[key] ?? key;
  for (const [k, v] of Object.entries(params || {})) s = s.split(`{${k}}`).join(v);
  return s;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const pad = (n) => String(n).padStart(2, "0");
function nowStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const todayIso = () => nowStr().slice(0, 10);
function itDate(v) {
  if (!v || v.length < 10) return v || "";
  return `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`;
}
const hm = (v) => (v && v.length >= 16 ? v.slice(11, 16) : "");
const addr = (p, s) => `${s[p + "_indirizzo"]}, ${s[p + "_cap"]} ${s[p + "_citta"]}${s[p + "_provincia"] ? ` (${s[p + "_provincia"]})` : ""}`;
const badge = (st) => `<span class="badge badge-${st}">${esc(t("status_" + st))}</span>`;
const isStaff = () => state.profile && ["admin", "corriere"].includes(state.profile.role);
const role = () => (state.profile ? state.profile.role : null);
const go = (hash) => { location.hash = hash; };
const flash = (msg, cat = "success") => { pendingFlash = { msg, cat }; };

function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = typeof v === "string" ? v.trim() : v;
  return out;
}

function field(name, label, f, errors, o = {}) {
  const { type = "text", required = true, col = "col-6", hint = null, attrs = "" } = o;
  const val = esc(f[name] ?? "");
  const input = type === "textarea"
    ? `<textarea id="${name}" name="${name}" ${attrs}>${val}</textarea>`
    : `<input id="${name}" name="${name}" type="${type}" value="${val}" ${required ? "required" : ""} ${attrs}>`;
  const err = errors[name] ? `<div class="error">${esc(errors[name])}</div>`
    : hint ? `<div class="hint">${esc(hint)}</div>` : "";
  return `<div class="field ${col} ${errors[name] ? "has-error" : ""}">
    <label for="${name}">${esc(label)}${required ? ' <span class="req">*</span>' : ""}</label>${input}${err}</div>`;
}

function require(data, keys, errors) {
  for (const k of keys) if (!data[k]) errors[k] = t("err_required");
}

function busy(form, on) {
  form.querySelectorAll("button").forEach((b) => { b.disabled = on; });
}

// ------------------------------------------------------------------ layout

function renderHeader() {
  document.documentElement.lang = lang();
  document.documentElement.dir = RTL.includes(lang()) ? "rtl" : "ltr";
  const r = role();
  const path = location.hash.split("?")[0];
  const link = (href, key) => `<a href="${href}" class="${path === href ? "active" : ""}">${esc(t(key))}</a>`;
  let nav = "";
  if (state.user && state.user.emailVerified && state.profile) {
    if (r === "cliente") nav += link("#/area-cliente", "nav_my_shipments") + link("#/nuova", "nav_new_shipment");
    else if (r === "admin") nav += link("#/admin", "nav_orders") + link("#/corriere", "nav_deliveries") + link("#/utenti", "nav_users");
    else if (r === "corriere") nav += link("#/corriere", "nav_deliveries");
    nav += link("#/profilo", "nav_profile");
  }
  if (state.user) nav += `<button class="linklike" id="logout" type="button">${esc(t("nav_logout"))}</button>`;
  else nav += link("#/accedi", "nav_login") + link("#/registrati", "nav_register");
  const opts = Object.entries(LANGS).map(([c, n]) => `<option value="${c}" ${c === lang() ? "selected" : ""}>${esc(n)}</option>`).join("");
  document.getElementById("top").innerHTML = `
    <a class="brand" href="#/"><img src="/img/logo-mark.jpg" alt="IxGoo Courier & Logistics"></a>
    <nav class="nav">${nav}<select class="lang-select" id="lang" aria-label="${esc(t("language"))}">${opts}</select></nav>`;
  document.getElementById("lang").onchange = (e) => setLang(e.target.value);
  const lo = document.getElementById("logout");
  if (lo) lo.onclick = async () => { await signOut(auth); go("#/"); };
}

function render(html, title) {
  renderHeader();
  document.title = `${title || t("app_title")} · IxGoo`;
  let f = "";
  if (pendingFlash) {
    f = `<div class="flash flash-${pendingFlash.cat}">${esc(pendingFlash.msg)}</div>`;
    pendingFlash = null;
  }
  document.getElementById("main").innerHTML = f + html;
}

function setLang(code) {
  state.lang = code;
  try { localStorage.setItem("ixgoo_lang", code); } catch (e) { /* ignorato */ }
  if (state.user && state.profile) updateDoc(doc(db, "users", state.user.uid), { lang: code }).catch(() => {});
  route();
}

// Se Firestore rifiuta una lettura, il motivo più comune è un token di accesso vecchio
// (es. appena confermata l'email): lo rinnova una volta e riprova, poi mostra 403.
let deniedRetried = false;
function denied() {
  if (!deniedRetried && auth.currentUser) {
    deniedRetried = true;
    auth.currentUser.getIdToken(true).then(() => setTimeout(route, 300)).catch(() => errorView(403));
  } else {
    errorView(403);
  }
}
const allowed = () => { deniedRetried = false; };

function errorView(code) {
  render(`<div class="narrow card" style="text-align:center"><h1>${code}</h1>
    <p>${esc(t("error_" + code))}</p><a class="btn btn-primary" href="#/">${esc(t("back_home"))}</a></div>`);
}

function homeFor() {
  if (!state.user) return "#/";
  if (!state.user.emailVerified) return "#/verifica";
  return { admin: "#/admin", corriere: "#/corriere" }[role()] || "#/area-cliente";
}

// ------------------------------------------------------------------ router

const routes = {
  "": viewHome, registrati: viewRegister, accedi: viewLogin, "password-dimenticata": viewForgot,
  verifica: viewVerify, "area-cliente": viewClient, nuova: viewNew, spedizione: viewDetail,
  etichetta: viewLabel, admin: viewAdmin, utenti: viewUsers, corriere: viewCourier, profilo: viewProfile,
};
// pagine che richiedono login (e quali ruoli)
const guards = {
  "area-cliente": ["cliente"], nuova: ["cliente"], spedizione: [], etichetta: [],
  admin: ["admin"], utenti: ["admin"], corriere: ["admin", "corriere"], profilo: [],
};

function route() {
  // aspetta di sapere chi è connesso e di avere il suo profilo (ruolo)
  if (!state.ready || (state.user && !state.profileLoaded)) return;
  unsubs.forEach((u) => u());
  unsubs = [];
  const [path, qs] = location.hash.replace(/^#\/?/, "").split("?");
  const [name, arg] = path.split("/");
  const params = new URLSearchParams(qs || "");
  const view = routes[name];
  if (!view) return errorView(404);
  if (name in guards) {
    if (!state.user) {
      flash(t("flash_login_needed"), "info");
      return go(`#/accedi?next=${encodeURIComponent("#/" + path + (qs ? "?" + qs : ""))}`);
    }
    if (!state.user.emailVerified) return go("#/verifica");
    if (!state.profile || state.profile.active === false) return errorView(403);
    if (guards[name].length && !guards[name].includes(role())) return errorView(403);
  }
  try {
    view(arg ? decodeURIComponent(arg) : undefined, params);
  } catch (e) {
    console.error(e);
    errorView(404);
  }
}

window.addEventListener("hashchange", route);

onAuthStateChanged(auth, (user) => {
  state.user = user;
  if (profileUnsub) { profileUnsub(); profileUnsub = null; }
  state.profile = null;
  state.profileLoaded = !user;
  if (!user) { state.ready = true; route(); return; }
  profileUnsub = onSnapshot(doc(db, "users", user.uid), (snap) => {
    const wasLoaded = state.profileLoaded;
    state.profile = snap.exists() ? snap.data() : null;
    state.profileLoaded = true;
    state.ready = true;
    // al primo caricamento, o se cambia ruolo/stato, ridisegna la pagina (non mentre si compila un modulo)
    if (!wasLoaded || !document.querySelector("#main form")) route();
  }, () => { state.profileLoaded = true; state.ready = true; route(); });
});

// ------------------------------------------------------------------ pagine pubbliche

function viewHome() {
  if (state.user) return go(homeFor());
  const steps = [1, 2, 3, 4].map((i) => `<div class="step"><b>${i}</b><h3>${esc(t(`step${i}_title`))}</h3>
    <p>${esc(t(i === 4 ? "step4_text2" : `step${i}_text`))}</p></div>`).join("");
  render(`<section class="hero"><img src="/img/logo-wide.jpg" alt="IxGoo Courier & Logistics">
    <div class="hero-text"><h1>${esc(t("hero_title"))}</h1><p>${esc(t("hero_text"))}</p>
    <div class="actions"><a class="btn btn-gold btn-lg" href="#/registrati">${esc(t("nav_register"))}</a>
    <a class="btn btn-ghost btn-lg" style="color:#fff;border-color:#444" href="#/accedi">${esc(t("nav_login"))}</a></div></div></section>
    <div class="steps">${steps}</div>`);
}

const REG_FIELDS = ["ragione_sociale", "nome", "cognome", "indirizzo", "cap", "citta", "provincia", "telefono", "email"];
const REG_REQUIRED = ["nome", "cognome", "indirizzo", "cap", "citta", "telefono", "email"];

function validateProfile(d, errors) {
  require(d, REG_REQUIRED, errors);
  if (d.email && !EMAIL_RE.test(d.email)) errors.email = t("err_email");
  if (d.telefono && !PHONE_RE.test(d.telefono)) errors.telefono = t("err_phone");
  if (d.cap && !ZIP_RE.test(d.cap)) errors.cap = t("err_zip");
}

function profileFields(d) {
  return {
    ragione_sociale: d.ragione_sociale || null, nome: d.nome, cognome: d.cognome,
    indirizzo: d.indirizzo, cap: d.cap, citta: d.citta, provincia: d.provincia || null,
    telefono: d.telefono,
  };
}

function profileGrid(f, errors, withEmail) {
  return field("ragione_sociale", t("company_name"), f, errors, { required: false, col: "col-12", hint: t("company_hint") })
    + field("nome", t("first_name"), f, errors) + field("cognome", t("last_name"), f, errors)
    + field("indirizzo", t("street"), f, errors, { col: "col-12", attrs: 'autocomplete="street-address"' })
    + field("cap", t("zip"), f, errors, { col: "col-3" }) + field("citta", t("city"), f, errors)
    + field("provincia", t("region"), f, errors, { required: false, col: "col-3" })
    + field("telefono", t("phone"), f, errors, { type: "tel" })
    + (withEmail ? field("email", t("email"), f, errors, { type: "email" }) : "");
}

function viewRegister(_, __, f = {}, errors = {}) {
  if (state.user) return go(homeFor());
  render(`<div class="medium"><h1>${esc(t("register_title"))}</h1><p class="muted">${esc(t("register_intro"))}</p>
    <form class="card" id="reg" novalidate><div class="grid">${profileGrid(f, errors, true)}
    ${field("password", t("password"), {}, errors, { type: "password", hint: t("password_hint"), attrs: 'autocomplete="new-password"' })}
    ${field("password2", t("password_repeat"), {}, errors, { type: "password", attrs: 'autocomplete="new-password"' })}
    <div class="field col-12 ${errors.privacy ? "has-error" : ""}"><label class="check"><input type="checkbox" name="privacy" value="1" ${f.privacy ? "checked" : ""}>
    <span>${esc(t("privacy_accept"))}</span></label>${errors.privacy ? `<div class="error">${esc(errors.privacy)}</div>` : ""}</div>
    </div><p></p><button class="btn btn-primary btn-lg btn-block" type="submit">${esc(t("register_submit"))}</button>
    <p class="small muted" style="text-align:center">${esc(t("have_account"))} <a href="#/accedi">${esc(t("nav_login"))}</a></p></form></div>`,
  t("nav_register"));
  document.getElementById("reg").onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    d.email = (d.email || "").toLowerCase();
    const err = {};
    validateProfile(d, err);
    if ((d.password || "").length < 8) err.password = t("err_password_len");
    else if (d.password !== d.password2) err.password2 = t("err_password_match");
    if (!d.privacy) err.privacy = t("err_privacy");
    if (Object.keys(err).length) return viewRegister(null, null, d, err);
    busy(e.target, true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, d.email, d.password);
      await setDoc(doc(db, "users", cred.user.uid), {
        ...profileFields(d), role: ADMIN_EMAILS.includes(d.email) ? "admin" : "cliente", email: d.email, lang: lang(), active: true, created_at: nowStr(),
      });
      auth.languageCode = lang();
      await sendEmailVerification(cred.user);
      go("#/verifica");
    } catch (ex) {
      const map = { "auth/email-already-in-use": ["email", "err_email_taken"], "auth/invalid-email": ["email", "err_email"], "auth/weak-password": ["password", "err_password_len"] };
      const [k, msg] = map[ex.code] || [null, "err_generic"];
      if (!k) flash(t(msg), "error"); else err[k] = t(msg);
      viewRegister(null, null, d, err);
    }
  };
}

function viewLogin(_, params) {
  if (state.user && state.user.emailVerified) return go(homeFor());
  render(`<div class="narrow"><h1>${esc(t("login_title"))}</h1><form class="card" id="login"><div class="grid">
    <div class="field col-12"><label for="email">${esc(t("email"))}</label><input id="email" name="email" type="email" required autocomplete="username"></div>
    <div class="field col-12"><label for="password">${esc(t("password"))}</label><input id="password" name="password" type="password" required autocomplete="current-password"></div>
    </div><p></p><button class="btn btn-primary btn-lg btn-block" type="submit">${esc(t("nav_login"))}</button>
    <p class="small" style="text-align:center"><a href="#/password-dimenticata">${esc(t("forgot_password"))}</a></p>
    <p class="small muted" style="text-align:center">${esc(t("no_account"))} <a href="#/registrati">${esc(t("nav_register"))}</a></p></form></div>`, t("nav_login"));
  document.getElementById("login").onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    busy(e.target, true);
    try {
      const cred = await signInWithEmailAndPassword(auth, d.email.toLowerCase(), d.password);
      if (!cred.user.emailVerified) return go("#/verifica");
      const nxt = params.get("next");
      go(nxt && nxt.startsWith("#/") ? nxt : "#/");
    } catch (ex) {
      busy(e.target, false);
      flash(ex.code && ex.code.startsWith("auth/") ? t("flash_login_bad") : t("err_generic"), "error");
      viewLogin(null, params);
    }
  };
}

function viewForgot() {
  render(`<div class="narrow"><h1>${esc(t("forgot_password"))}</h1><form class="card" id="forgot">
    <div class="field"><label for="email">${esc(t("email"))}</label><input id="email" name="email" type="email" required></div><p></p>
    <button class="btn btn-primary btn-block" type="submit">${esc(t("send"))}</button></form></div>`);
  document.getElementById("forgot").onsubmit = async (e) => {
    e.preventDefault();
    busy(e.target, true);
    auth.languageCode = lang();
    try { await sendPasswordResetEmail(auth, formData(e.target).email.toLowerCase()); } catch (ex) { /* stessa risposta in ogni caso */ }
    flash(t("reset_sent"), "info");
    go("#/accedi");
  };
}

function viewVerify() {
  if (!state.user) return go("#/accedi");
  if (state.user.emailVerified) return go(homeFor());
  render(`<div class="narrow card" style="text-align:center"><div style="font-size:48px">✉️</div>
    <h1>${esc(t("check_email_title"))}</h1><p>${esc(t("check_email_text", { email: state.user.email }))}</p>
    <div class="actions" style="justify-content:center"><button class="btn btn-primary" id="done">${esc(t("verified_continue"))}</button></div>
    <p class="small muted">${esc(t("check_email_spam"))} <a href="#" id="resend">${esc(t("resend_link"))}</a></p></div>`);
  document.getElementById("done").onclick = async () => {
    await state.user.reload();
    if (auth.currentUser.emailVerified) {
      await auth.currentUser.getIdToken(true); // aggiorna il token: le regole vedono email_verified
      // ricarica la pagina, così anche Firestore riparte con il token nuovo
      location.hash = homeFor();
      location.reload();
    } else { flash(t("verify_not_yet"), "error"); viewVerify(); }
  };
  document.getElementById("resend").onclick = async (e) => {
    e.preventDefault();
    auth.languageCode = lang();
    try { await sendEmailVerification(state.user); flash(t("check_email_text", { email: state.user.email }), "info"); } catch (ex) { flash(t("err_generic"), "error"); }
    viewVerify();
  };
}

// ------------------------------------------------------------------ cliente

function viewClient() {
  render(`<div class="page-head"><h1>${esc(t("nav_my_shipments"))}</h1><a class="btn btn-gold" href="#/nuova">+ ${esc(t("nav_new_shipment"))}</a></div>
    <div class="card" style="padding:8px 0" id="list"><div class="empty">${esc(t("loading"))}</div></div>`, t("nav_my_shipments"));
  const q = query(collection(db, "shipments"), where("user_id", "==", state.user.uid));
  unsubs.push(onSnapshot(q, (snap) => {
    allowed();
    const rows = snap.docs.map((d) => d.data()).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const el = document.getElementById("list");
    if (!el) return;
    el.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>${esc(t("code"))}</th><th>${esc(t("pickup"))}</th>
      <th>${esc(t("destination"))}</th><th>${esc(t("status"))}</th><th></th></tr></thead><tbody>${rows.map((s) => `
      <tr class="rowlink" data-href="#/spedizione/${esc(s.code)}"><td class="code">${esc(s.code)}</td>
      <td>${itDate(s.pickup_date)} ${esc(s.pickup_time)}<br><span class="muted small">${esc(s.pickup_citta)}</span></td>
      <td>${esc(s.dest_nome)}<br><span class="muted small">${esc(s.dest_citta)}</span></td><td>${badge(s.status)}</td>
      <td>${["confermata", "consegnata"].includes(s.status) ? `<a class="btn btn-ghost small" href="#/etichetta/${esc(s.code)}">QR</a>` : ""}</td></tr>`).join("")}
      </tbody></table></div>`
      : `<div class="empty"><p>${esc(t("no_shipments_yet"))}</p><a class="btn btn-primary" href="#/nuova">${esc(t("book_first"))}</a></div>`;
    bindRowLinks(el);
  }, denied));
}

function bindRowLinks(el) {
  el.querySelectorAll("tr.rowlink").forEach((tr) => {
    tr.onclick = (e) => { if (!e.target.closest("a,button")) go(tr.dataset.href); };
  });
}

const SHIP_FIELDS = ["mitt_ragione_sociale", "mitt_nome", "mitt_cognome", "mitt_telefono", "mitt_email",
  "pickup_date", "pickup_time", "pickup_indirizzo", "pickup_cap", "pickup_citta", "pickup_provincia",
  "dest_nome", "dest_indirizzo", "dest_cap", "dest_citta", "dest_provincia", "dest_ref_nome",
  "dest_ref_telefono", "tipo", "colli", "peso", "note"];
const SHIP_REQUIRED = ["mitt_nome", "mitt_cognome", "mitt_telefono", "mitt_email", "pickup_date", "pickup_time",
  "pickup_indirizzo", "pickup_cap", "pickup_citta", "dest_nome", "dest_indirizzo", "dest_cap", "dest_citta",
  "dest_ref_nome", "dest_ref_telefono", "tipo"];

function newCode() {
  const d = nowStr();
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `IXG-${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${rnd}`;
}

function viewNew(_, __, f, errors = {}) {
  const u = state.profile;
  f = f || {
    mitt_ragione_sociale: u.ragione_sociale || "", mitt_nome: u.nome, mitt_cognome: u.cognome,
    mitt_telefono: u.telefono || "", mitt_email: u.email, pickup_indirizzo: u.indirizzo || "",
    pickup_cap: u.cap || "", pickup_citta: u.citta || "", pickup_provincia: u.provincia || "",
    tipo: "pacco", colli: "1", pickup_date: todayIso(),
  };
  const section = (n, title, body) => `<section class="card"><h2><span class="num">${n}</span> ${esc(title)}</h2><div class="grid">${body}</div></section>`;
  render(`<div class="medium"><h1>${esc(t("new_shipment_title"))}</h1><p class="muted">${esc(t("new_shipment_intro"))}</p>
    ${Object.keys(errors).length ? `<div class="flash flash-error">${esc(t("form_has_errors"))}</div>` : ""}
    <form id="ship" novalidate>
    ${section(1, t("sender"), field("mitt_ragione_sociale", t("company_name"), f, errors, { required: false, col: "col-12" })
      + field("mitt_nome", t("contact_first_name"), f, errors) + field("mitt_cognome", t("contact_last_name"), f, errors)
      + field("mitt_telefono", t("phone"), f, errors, { type: "tel" }) + field("mitt_email", t("email"), f, errors, { type: "email" }))}
    ${section(2, t("pickup"), field("pickup_date", t("pickup_date"), f, errors, { type: "date", attrs: `min="${todayIso()}"` })
      + field("pickup_time", t("pickup_time"), f, errors, { type: "time" })
      + field("pickup_indirizzo", t("pickup_address"), f, errors, { col: "col-12" })
      + field("pickup_cap", t("zip"), f, errors, { col: "col-3" }) + field("pickup_citta", t("city"), f, errors)
      + field("pickup_provincia", t("region"), f, errors, { required: false, col: "col-3" }))}
    ${section(3, t("destination"), field("dest_nome", t("recipient_name"), f, errors, { col: "col-12", hint: t("recipient_hint") })
      + field("dest_indirizzo", t("street"), f, errors, { col: "col-12" })
      + field("dest_cap", t("zip"), f, errors, { col: "col-3" }) + field("dest_citta", t("city"), f, errors)
      + field("dest_provincia", t("region"), f, errors, { required: false, col: "col-3" })
      + field("dest_ref_nome", t("recipient_contact"), f, errors) + field("dest_ref_telefono", t("recipient_phone"), f, errors, { type: "tel" }))}
    ${section(4, t("what_we_carry"), `<div class="field col-6"><label>${esc(t("type"))} <span class="req">*</span></label><div class="segmented">
        <label><input type="radio" name="tipo" value="busta" ${f.tipo === "busta" ? "checked" : ""}><span>✉ ${esc(t("type_busta"))}</span></label>
        <label><input type="radio" name="tipo" value="pacco" ${f.tipo !== "busta" ? "checked" : ""}><span>📦 ${esc(t("type_pacco"))}</span></label></div></div>`
      + field("colli", t("parcels"), f, errors, { type: "number", col: "col-3", attrs: 'min="1" max="99"' })
      + field("peso", t("weight"), f, errors, { required: false, col: "col-3" })
      + field("note", t("notes"), f, errors, { type: "textarea", required: false, col: "col-12", hint: t("notes_hint") }))}
    <button class="btn btn-primary btn-lg btn-block" type="submit">${esc(t("submit_booking"))}</button></form></div>`, t("nav_new_shipment"));
  document.getElementById("ship").onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    const err = {};
    require(d, SHIP_REQUIRED, err);
    if (d.mitt_email && !EMAIL_RE.test(d.mitt_email)) err.mitt_email = t("err_email");
    for (const k of ["mitt_telefono", "dest_ref_telefono"]) if (d[k] && !PHONE_RE.test(d[k])) err[k] = t("err_phone");
    for (const k of ["pickup_cap", "dest_cap"]) if (d[k] && !ZIP_RE.test(d[k])) err[k] = t("err_zip");
    const colli = parseInt(d.colli || "1", 10);
    if (!(colli >= 1 && colli <= 99)) err.colli = t("err_parcels");
    if (d.pickup_date && d.pickup_time && `${d.pickup_date} ${d.pickup_time}` < nowStr().slice(0, 16)) err.pickup_date = t("err_pickup_past");
    if (Object.keys(err).length) { viewNew(null, null, d, err); window.scrollTo(0, 0); return; }
    busy(e.target, true);
    const data = {};
    for (const k of SHIP_FIELDS) data[k] = d[k] || null;
    Object.assign(data, {
      colli, user_id: state.user.uid, status: "in_attesa", created_at: nowStr(),
      confirmed_at: null, confirmed_by: null, delivered_at: null, delivered_by: null, cancelled_at: null,
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      try {
        // se il codice esistesse già, la scrittura diventerebbe una modifica e le regole la rifiutano
        await setDoc(doc(db, "shipments", code), { ...data, code });
        flash(t("flash_shipment_sent", { code }));
        return go(`#/spedizione/${code}`);
      } catch (ex) {
        if (ex.code !== "permission-denied" || attempt === 4) {
          console.error(ex);
          busy(e.target, false);
          flash(t("err_generic"), "error");
          return viewNew(null, null, d, {});
        }
      }
    }
  };
}

// ------------------------------------------------------------------ dettaglio spedizione

const nameCache = {};
async function personName(uid) {
  if (!uid) return null;
  if (!(uid in nameCache)) {
    try {
      const s = await getDoc(doc(db, "users", uid));
      nameCache[uid] = s.exists() ? s.data() : null;
    } catch (e) { nameCache[uid] = null; }
  }
  return nameCache[uid];
}

function viewDetail(code) {
  render(`<div class="empty">${esc(t("loading"))}</div>`, code);
  unsubs.push(onSnapshot(doc(db, "shipments", code), async (snap) => {
    allowed();
    if (!snap.exists()) return errorView(404);
    const s = snap.data();
    let owner = null; let confBy = null; let delBy = null;
    if (isStaff()) {
      [owner, confBy, delBy] = await Promise.all([personName(s.user_id), personName(s.confirmed_by), personName(s.delivered_by)]);
    }
    renderDetail(s, owner, confBy, delBy);
  }, () => errorView(404)));
}

function renderDetail(s, owner, confBy, delBy) {
  const staff = isStaff();
  const r = role();
  const fullName = (u) => (u ? `${u.nome} ${u.cognome}` : "");
  const now = nowStr();
  const banner = { in_attesa: t("banner_pending"), confermata: t("banner_confirmed"), annullata: t("banner_cancelled"),
    consegnata: t("banner_delivered", { date: itDate(s.delivered_at), time: hm(s.delivered_at) }) }[s.status];
  const cancelForm = (id) => `<details><summary class="btn btn-danger">${esc(t("cancel_booking"))}</summary>
    <form id="${id}" style="margin-top:10px"><div class="field"><label for="${id}-m">${esc(t("cancel_reason"))}</label><input id="${id}-m" name="motivo"></div><p></p>
    <button class="btn btn-danger" type="submit">${esc(t("cancel_booking"))}</button></form></details>`;
  let actions = "";
  if (r === "admin" && s.status === "in_attesa") {
    actions += `<div class="card" style="border:2px solid var(--gold)"><h2>${esc(t("admin_action"))}</h2><p class="muted">${esc(t("admin_confirm_text2"))}</p>
      <div class="actions"><button class="btn btn-ok btn-lg" id="confirm">✓ ${esc(t("confirm_receipt"))}</button>${cancelForm("acancel")}</div></div>`;
  }
  if (staff && s.status === "confermata") {
    const d = now.slice(0, 10); const h = now.slice(11, 16);
    actions += `<div class="card deliver-box"><h2>🚚 ${esc(t("register_delivery"))}</h2><form id="deliver"><div class="grid">
      <div class="field col-6"><label for="d">${esc(t("date"))}</label><input id="d" type="date" name="data" value="${d}" max="${d}" required></div>
      <div class="field col-6"><label for="h">${esc(t("time"))}</label><input id="h" type="time" name="ora" value="${h}" required></div></div>
      <button class="btn btn-ok btn-lg btn-block" type="submit" id="deliver-btn">✓ ${esc(t("btn_delivered", { date: itDate(d), time: h }))}</button></form>
      ${r === "admin" ? `<div style="margin-top:12px">${cancelForm("acancel")}</div>` : ""}</div>`;
  }
  const qrButtons = ["confermata", "consegnata"].includes(s.status)
    ? `<a class="btn btn-gold" href="#/etichetta/${esc(s.code)}">🖨 ${esc(t("print_label"))}</a>
       <button class="btn btn-ghost" id="png">${esc(t("download_qr"))}</button>` : "";
  const mapLink = (p) => `<a href="https://maps.google.com/?q=${encodeURIComponent(addr(p, s))}" target="_blank" rel="noopener">${esc(addr(p, s))}</a>`;
  const tel = (n) => `<a href="tel:${esc(n)}">${esc(n)}</a>`;
  const kv = (k, v) => `<dt>${esc(t(k))}</dt><dd>${v}</dd>`;
  render(`<div class="page-head"><div><div class="muted small">${esc(t("shipment"))}</div><h1 class="code">${esc(s.code)}</h1></div>
    <div class="actions">${qrButtons}</div></div>
    <div class="status-banner ${s.status}"><div><strong>${esc(t("status_" + s.status))}</strong> — ${esc(banner)}</div>
    ${r === "cliente" && s.status === "in_attesa" ? `<button class="btn btn-danger" id="ccancel">${esc(t("cancel_booking"))}</button>` : ""}</div>
    ${actions}
    <div class="detail-grid">
      <section class="card"><h2>📍 ${esc(t("pickup"))}</h2><dl class="kv">
        ${kv("when", `<strong>${itDate(s.pickup_date)} · ${esc(s.pickup_time)}</strong>`)}${kv("address", mapLink("pickup"))}
        ${s.mitt_ragione_sociale ? kv("company_name", esc(s.mitt_ragione_sociale)) : ""}
        ${kv("contact", esc(`${s.mitt_nome} ${s.mitt_cognome}`))}${kv("phone", tel(s.mitt_telefono))}${kv("email", esc(s.mitt_email))}</dl></section>
      <section class="card"><h2>🏁 ${esc(t("destination"))}</h2><dl class="kv">
        ${kv("recipient", `<strong>${esc(s.dest_nome)}</strong>`)}${kv("address", mapLink("dest"))}
        ${kv("contact", esc(s.dest_ref_nome))}${kv("phone", tel(s.dest_ref_telefono))}</dl></section>
      <section class="card"><h2>📦 ${esc(t("details"))}</h2><dl class="kv">
        ${kv("type", esc(t("type_" + s.tipo)))}${kv("parcels", esc(s.colli))}
        ${s.peso ? kv("weight", esc(s.peso)) : ""}${s.note ? kv("notes", esc(s.note)) : ""}
        ${staff && owner ? kv("customer", esc(`${owner.ragione_sociale || fullName(owner)} · ${owner.email}`)) : ""}</dl></section>
      <section class="card"><h2>🕓 ${esc(t("history"))}</h2><ul class="timeline">
        <li class="done">${esc(t("tl_created"))}: ${itDate(s.created_at)} ${hm(s.created_at)}</li>
        ${s.confirmed_at ? `<li class="done">${esc(t("tl_confirmed"))}: ${itDate(s.confirmed_at)} ${hm(s.confirmed_at)}${staff && confBy ? " · " + esc(fullName(confBy)) : ""}</li>`
          : s.status === "in_attesa" ? `<li>${esc(t("tl_confirmed"))}…</li>` : ""}
        ${s.delivered_at ? `<li class="done">${esc(t("tl_delivered"))}: ${itDate(s.delivered_at)} ${hm(s.delivered_at)}${staff && delBy ? " · " + esc(fullName(delBy)) : ""}</li>`
          : s.status !== "annullata" ? `<li>${esc(t("tl_delivered"))}…</li>` : ""}
        ${s.cancelled_at ? `<li class="done">${esc(t("status_annullata"))}: ${itDate(s.cancelled_at)} ${hm(s.cancelled_at)}${s.cancel_reason ? " — " + esc(s.cancel_reason) : ""}</li>` : ""}
      </ul></section></div>`, s.code);

  const ref = doc(db, "shipments", s.code);
  const act = async (changes, okMsg) => {
    try { await updateDoc(ref, changes); if (okMsg) flash(okMsg); } catch (ex) { console.error(ex); flash(t("err_generic"), "error"); }
  };
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el[ev] = fn; };
  on("ccancel", "onclick", () => { if (confirm(t("confirm_cancel"))) act({ status: "annullata", cancelled_at: nowStr() }, t("flash_cancelled", { code: s.code })); });
  on("confirm", "onclick", (e) => { e.target.disabled = true; act({ status: "confermata", confirmed_at: nowStr(), confirmed_by: state.user.uid }, t("flash_confirmed2", { code: s.code })); });
  on("acancel", "onsubmit", (e) => {
    e.preventDefault();
    act({ status: "annullata", cancelled_at: nowStr(), cancel_reason: formData(e.target).motivo || null }, t("flash_cancelled", { code: s.code }));
  });
  on("png", "onclick", () => downloadQrPng(s));
  const form = document.getElementById("deliver");
  if (form) {
    const d = document.getElementById("d"); const h = document.getElementById("h"); const b = document.getElementById("deliver-btn");
    const upd = () => { b.textContent = "✓ " + t("btn_delivered", { date: itDate(d.value), time: h.value }); };
    d.oninput = upd; h.oninput = upd;
    form.onsubmit = (e) => {
      e.preventDefault();
      const when = `${d.value} ${h.value}`;
      if (!d.value || !h.value) { flash(t("err_datetime"), "error"); return renderDetail(s, owner, confBy, delBy); }
      if (when > nowStr(new Date(Date.now() + 5 * 60000)).slice(0, 16)) { flash(t("flash_deliver_future"), "error"); return renderDetail(s, owner, confBy, delBy); }
      busy(form, true);
      act({ status: "consegnata", delivered_at: `${when}:00`, delivered_by: state.user.uid },
        t("flash_delivered", { date: itDate(d.value), time: h.value }))
        .then(() => { if (role() === "corriere") go("#/corriere"); });
    };
  }
}

// ------------------------------------------------------------------ QR ed etichetta

function qrUrl(s) {
  return `${location.origin}/#/spedizione/${encodeURIComponent(s.code)}`;
}

function makeQr(s) {
  const qr = window.qrcode(0, "M");
  qr.addData(qrUrl(s));
  qr.make();
  return qr;
}

function downloadQrPng(s) {
  const qr = makeQr(s);
  const n = qr.getModuleCount(); const cell = 10; const margin = 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = (n + margin * 2) * cell;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
  }
  const a = document.createElement("a");
  a.download = `QR-${s.code}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
}

async function viewLabel(code) {
  render(`<div class="empty">${esc(t("loading"))}</div>`);
  let snap;
  try { snap = await getDoc(doc(db, "shipments", code)); } catch (e) { return errorView(404); }
  if (!snap.exists()) return errorView(404);
  const s = snap.data();
  if (!["confermata", "consegnata"].includes(s.status)) { flash(t("flash_label_after_confirm"), "info"); return go(`#/spedizione/${code}`); }
  const svg = makeQr(s).createSvgTag({ cellSize: 5, margin: 1, scalable: true });
  render(`<div class="actions no-print" style="justify-content:space-between;margin:0 auto 16px;max-width:760px">
    <a href="#/spedizione/${esc(s.code)}">← ${esc(s.code)}</a><button class="btn btn-gold" id="print">🖨 ${esc(t("print"))}</button></div>
    <p class="muted small no-print" style="max-width:760px;margin:0 auto 16px">${esc(t("label_instructions"))}</p>
    <div class="label"><div class="label-head"><img src="/img/logo-mark.jpg" alt="IxGoo"><span class="code">${esc(s.code)}</span></div>
    <div class="label-body"><div class="label-qr">${svg}<div class="scan-hint">${esc(t("scan_hint"))}</div></div>
    <div class="label-info">
      <div class="label-to"><h3>${esc(t("destination"))}</h3><div class="big">${esc(s.dest_nome)}</div><div>${esc(addr("dest", s))}</div>
        <div>${esc(t("contact"))}: ${esc(s.dest_ref_nome)} · ☎ <span class="ltr">${esc(s.dest_ref_telefono)}</span></div></div>
      <div><h3>${esc(t("sender"))} / ${esc(t("pickup"))}</h3><div><strong>${esc(s.mitt_ragione_sociale || `${s.mitt_nome} ${s.mitt_cognome}`)}</strong></div>
        <div>${esc(addr("pickup", s))}</div><div>${esc(t("contact"))}: ${esc(`${s.mitt_nome} ${s.mitt_cognome}`)} · ☎ <span class="ltr">${esc(s.mitt_telefono)}</span></div>
        <div>${esc(t("pickup"))}: ${itDate(s.pickup_date)} ${esc(s.pickup_time)}</div></div>
      <div><h3>${esc(t("details"))}</h3><div>${esc(t("type_" + s.tipo))} · ${esc(t("parcels"))}: ${esc(s.colli)}${s.peso ? ` · ${esc(t("weight"))}: ${esc(s.peso)}` : ""}</div>
        ${s.note ? `<div>${esc(t("notes"))}: ${esc(s.note)}</div>` : ""}</div>
    </div></div></div>`, `${t("label")} ${s.code}`);
  document.getElementById("print").onclick = () => window.print();
}

// ------------------------------------------------------------------ admin

function viewAdmin(_, params) {
  const status = params.get("stato") || "in_attesa";
  const q0 = params.get("q") || "";
  render(`<div class="page-head"><h1>${esc(t("nav_orders"))}</h1></div><div class="tabs" id="tabs"></div>
    <form class="search" id="search"><input name="q" value="${esc(q0)}" placeholder="${esc(t("search_placeholder"))}">
    <button class="btn btn-ghost" type="submit">${esc(t("search"))}</button></form>
    <div class="card" style="padding:8px 0" id="list"><div class="empty">${esc(t("loading"))}</div></div>`, t("nav_orders"));
  document.getElementById("search").onsubmit = (e) => {
    e.preventDefault();
    go(`#/admin?stato=${encodeURIComponent(status)}&q=${encodeURIComponent(formData(e.target).q)}`);
  };
  unsubs.push(onSnapshot(collection(db, "shipments"), (snap) => {
    allowed();
    const all = snap.docs.map((d) => d.data());
    const counts = Object.fromEntries(STATUS.map((st) => [st, all.filter((s) => s.status === st).length]));
    document.getElementById("tabs").innerHTML = STATUS.map((st) => `<a href="#/admin?stato=${st}" class="${status === st ? "active" : ""}">${esc(t("status_" + st))}<span class="count">${counts[st]}</span></a>`).join("")
      + `<a href="#/admin?stato=tutte" class="${STATUS.includes(status) ? "" : "active"}">${esc(t("all"))}</a>`;
    let rows = all.filter((s) => !STATUS.includes(status) || s.status === status);
    const q = q0.toLowerCase();
    if (q) rows = rows.filter((s) => ["code", "mitt_ragione_sociale", "mitt_cognome", "dest_nome", "dest_citta"].some((f) => (s[f] || "").toLowerCase().includes(q)));
    rows.sort(["in_attesa", "confermata"].includes(status)
      ? (a, b) => `${a.pickup_date} ${a.pickup_time}`.localeCompare(`${b.pickup_date} ${b.pickup_time}`)
      : (a, b) => b.created_at.localeCompare(a.created_at));
    const el = document.getElementById("list");
    el.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>${esc(t("code"))}</th><th>${esc(t("pickup"))}</th><th>${esc(t("sender"))}</th>
      <th>${esc(t("destination"))}</th><th>${esc(t("status"))}</th></tr></thead><tbody>${rows.map((s) => `
      <tr class="rowlink" data-href="#/spedizione/${esc(s.code)}"><td class="code">${esc(s.code)}</td>
      <td><strong>${itDate(s.pickup_date)} ${esc(s.pickup_time)}</strong><br><span class="muted small">${esc(s.pickup_citta)}</span></td>
      <td>${esc(s.mitt_ragione_sociale || `${s.mitt_nome} ${s.mitt_cognome}`)}<br><span class="muted small ltr">${esc(s.mitt_telefono)}</span></td>
      <td>${esc(s.dest_nome)}<br><span class="muted small">${esc(s.dest_citta)}</span></td><td>${badge(s.status)}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">${esc(t("no_results"))}</div>`;
    bindRowLinks(el);
  }, denied));
}

function viewUsers() {
  render(`<h1>${esc(t("nav_users"))}</h1><p class="muted">${esc(t("users_hint"))}</p>
    <section class="card"><h2>${esc(t("all_users"))}</h2><div id="list"><div class="empty">${esc(t("loading"))}</div></div></section>`, t("nav_users"));
  unsubs.push(onSnapshot(collection(db, "users"), (snap) => {
    allowed();
    const users = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.role === b.role ? (b.created_at || "").localeCompare(a.created_at || "") : ["admin", "corriere", "cliente"].indexOf(a.role) - ["admin", "corriere", "cliente"].indexOf(b.role)));
    const el = document.getElementById("list");
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>${esc(t("customer"))}</th><th>${esc(t("contact"))}</th><th>${esc(t("role"))}</th><th>${esc(t("status"))}</th></tr></thead><tbody>
      ${users.map((u) => {
        const self = u.id === state.user.uid;
        const roleSel = self ? esc(t("role_" + u.role)) : `<select data-uid="${esc(u.id)}" class="role-sel">${["cliente", "corriere", "admin"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${esc(t("role_" + r))}</option>`).join("")}</select>`;
        const act = self ? `<span class="badge badge-consegnata">${esc(t("active"))}</span>`
          : `<button class="btn ${u.active !== false ? "btn-danger" : "btn-ghost"} small toggle" data-uid="${esc(u.id)}" data-active="${u.active !== false}">${esc(u.active !== false ? t("disable") : t("enable"))}</button>`;
        return `<tr><td><strong>${esc(u.ragione_sociale || "—")}</strong></td>
          <td>${esc(`${u.nome} ${u.cognome}`)}<br><span class="muted small">${esc(u.email)} · <span class="ltr">${esc(u.telefono || "")}</span></span></td>
          <td>${roleSel}</td><td>${act}</td></tr>`;
      }).join("")}</tbody></table></div>`;
    el.querySelectorAll(".role-sel").forEach((sel) => {
      sel.onchange = () => updateDoc(doc(db, "users", sel.dataset.uid), { role: sel.value }).catch(() => { flash(t("err_generic"), "error"); route(); });
    });
    el.querySelectorAll(".toggle").forEach((b) => {
      b.onclick = () => updateDoc(doc(db, "users", b.dataset.uid), { active: b.dataset.active !== "true" }).catch(() => { flash(t("err_generic"), "error"); route(); });
    });
  }, denied));
}

// ------------------------------------------------------------------ corriere

function viewCourier() {
  render(`<div class="page-head"><h1>${esc(t("nav_deliveries"))}</h1></div><p class="muted">${esc(t("courier_intro"))}</p><div id="list"><div class="empty">${esc(t("loading"))}</div></div>`, t("nav_deliveries"));
  unsubs.push(onSnapshot(collection(db, "shipments"), (snap) => {
    allowed();
    const all = snap.docs.map((d) => d.data());
    const todo = all.filter((s) => s.status === "confermata")
      .sort((a, b) => `${a.pickup_date} ${a.pickup_time}`.localeCompare(`${b.pickup_date} ${b.pickup_time}`));
    const done = all.filter((s) => s.status === "consegnata" && (s.delivered_at || "").startsWith(todayIso()))
      .sort((a, b) => b.delivered_at.localeCompare(a.delivered_at));
    const el = document.getElementById("list");
    el.innerHTML = `<h2>${esc(t("to_deliver"))} (${todo.length})</h2>
      ${todo.map((s) => `<a class="card" href="#/spedizione/${esc(s.code)}" style="display:block;text-decoration:none;color:inherit">
        <div class="page-head" style="margin-bottom:6px"><span class="code">${esc(s.code)}</span><span class="badge badge-confermata">${esc(t("pickup"))} ${itDate(s.pickup_date)} ${esc(s.pickup_time)}</span></div>
        <div class="small"><strong>${esc(t("pickup"))}:</strong> ${esc(s.mitt_ragione_sociale || `${s.mitt_nome} ${s.mitt_cognome}`)} — ${esc(addr("pickup", s))}</div>
        <div class="small"><strong>${esc(t("destination"))}:</strong> ${esc(s.dest_nome)} — ${esc(addr("dest", s))}</div></a>`).join("")
        || `<div class="card empty">${esc(t("nothing_to_deliver"))}</div>`}
      <h2>${esc(t("delivered_today"))} (${done.length})</h2><div class="card" style="padding:8px 0">
      ${done.length ? `<table>${done.map((s) => `<tr class="rowlink" data-href="#/spedizione/${esc(s.code)}"><td class="code">${esc(s.code)}</td><td>${esc(s.dest_nome)}</td><td>${hm(s.delivered_at)}</td></tr>`).join("")}</table>` : '<div class="empty">—</div>'}</div>`;
    bindRowLinks(el);
  }, denied));
}

// ------------------------------------------------------------------ profilo

function viewProfile(_, __, f, errors = {}) {
  const u = state.profile;
  f = f || { ...u };
  render(`<div class="medium"><h1>${esc(t("nav_profile"))}</h1><p class="muted">${esc(state.user.email)} · ${esc(t("role_" + u.role))}</p>
    <form class="card" id="prof" novalidate><h2>${esc(t("my_data"))}</h2><div class="grid">${profileGrid(f, errors, false)}</div><p></p>
    <button class="btn btn-primary" type="submit">${esc(t("save"))}</button></form>
    <form class="card" id="pwd"><h2>${esc(t("change_password"))}</h2><div class="grid">
    ${field("old", t("current_password"), {}, errors, { type: "password", attrs: 'autocomplete="current-password"' })}
    ${field("new", t("new_password"), {}, errors, { type: "password", hint: t("password_hint"), attrs: 'autocomplete="new-password"' })}</div><p></p>
    <button class="btn btn-ghost" type="submit">${esc(t("change_password"))}</button></form></div>`, t("nav_profile"));
  document.getElementById("prof").onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    d.email = u.email;
    const err = {};
    validateProfile(d, err);
    if (Object.keys(err).length) return viewProfile(null, null, d, err);
    busy(e.target, true);
    try { await updateDoc(doc(db, "users", state.user.uid), profileFields(d)); flash(t("flash_profile_ok")); } catch (ex) { flash(t("err_generic"), "error"); }
    viewProfile();
  };
  document.getElementById("pwd").onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if ((d.new || "").length < 8) return viewProfile(null, null, null, { new: t("err_password_len") });
    busy(e.target, true);
    try {
      await reauthenticateWithCredential(state.user, EmailAuthProvider.credential(state.user.email, d.old));
      await updatePassword(state.user, d.new);
      flash(t("flash_password_ok"));
      viewProfile();
    } catch (ex) {
      viewProfile(null, null, null, ex.code === "auth/weak-password" ? { new: t("err_password_len") } : { old: t("err_old_password") });
    }
  };
}
