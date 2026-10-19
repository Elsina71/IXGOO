"""IxGoo Courier & Logistics - prenotazione spedizioni.

Ruoli: cliente, admin, corriere. Lingue: vedi i18n.py (greco predefinito).
Avvio: ./run.sh  (oppure .venv/bin/python app.py)
"""
import io
import os
import re
import secrets
import smtplib
import sqlite3
from datetime import datetime, date
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from functools import wraps
from pathlib import Path

import segno
from flask import (Flask, Response, abort, flash, g, redirect, render_template,
                   request, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash as _gen_hash

from i18n import DEFAULT_LANG, LANGS, RTL, translate

BASE_DIR = Path(__file__).resolve().parent


def generate_password_hash(password):
    # pbkdf2: funziona anche con il Python di sistema di macOS (senza scrypt)
    return _gen_hash(password, method="pbkdf2:sha256:600000")


def load_env():
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()

DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
OUTBOX = DATA_DIR / "outbox"
DB_PATH = os.environ.get("DATABASE", str(DATA_DIR / "ixgoo.db"))
SMTP_HOST = os.environ.get("SMTP_HOST", "")
MAIL_FROM = os.environ.get("MAIL_FROM", "IxGoo Courier <noreply@ixgoo.gr>")
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")


def secret_key():
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    key_file = DATA_DIR / "secret_key"
    if not key_file.exists():
        key_file.write_text(secrets.token_hex(32))
    return key_file.read_text().strip()


app = Flask(__name__)
app.config.update(SECRET_KEY=secret_key(), SESSION_COOKIE_HTTPONLY=True,
                  SESSION_COOKIE_SAMESITE="Lax")

STATUS = ["in_attesa", "confermata", "consegnata", "annullata"]
ROLES = ["cliente", "admin", "corriere"]
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+?[0-9 ./()-]{6,20}$")
ZIP_RE = re.compile(r"^[A-Za-z0-9 -]{3,10}$")


# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL DEFAULT 'cliente',
    ragione_sociale TEXT,
    nome TEXT NOT NULL,
    cognome TEXT NOT NULL,
    indirizzo TEXT,
    cap TEXT,
    citta TEXT,
    provincia TEXT,
    telefono TEXT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    email_confirmed INTEGER NOT NULL DEFAULT 0,
    confirm_token TEXT,
    lang TEXT NOT NULL DEFAULT 'el',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    qr_token TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'in_attesa',
    mitt_ragione_sociale TEXT,
    mitt_nome TEXT NOT NULL,
    mitt_cognome TEXT NOT NULL,
    mitt_telefono TEXT NOT NULL,
    mitt_email TEXT NOT NULL,
    pickup_date TEXT NOT NULL,
    pickup_time TEXT NOT NULL,
    pickup_indirizzo TEXT NOT NULL,
    pickup_cap TEXT NOT NULL,
    pickup_citta TEXT NOT NULL,
    pickup_provincia TEXT,
    dest_nome TEXT NOT NULL,
    dest_indirizzo TEXT NOT NULL,
    dest_cap TEXT NOT NULL,
    dest_citta TEXT NOT NULL,
    dest_provincia TEXT,
    dest_ref_nome TEXT NOT NULL,
    dest_ref_telefono TEXT NOT NULL,
    tipo TEXT NOT NULL,
    colli INTEGER NOT NULL DEFAULT 1,
    peso TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    confirmed_by INTEGER REFERENCES users(id),
    delivered_at TEXT,
    delivered_by INTEGER REFERENCES users(id),
    cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shipments_user ON shipments(user_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
"""


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    defaults = [
        ("admin", os.environ.get("ADMIN_EMAIL", "admin@ixgoo.gr"),
         os.environ.get("ADMIN_PASSWORD", "admin123"), "Admin", "IxGoo"),
        ("corriere", os.environ.get("COURIER_EMAIL", "courier@ixgoo.gr"),
         os.environ.get("COURIER_PASSWORD", "courier123"), "Courier", "IxGoo"),
    ]
    for role, email, password, nome, cognome in defaults:
        exists = db.execute("SELECT 1 FROM users WHERE role = ?", (role,)).fetchone()
        if not exists:
            db.execute(
                "INSERT INTO users (role, nome, cognome, email, password_hash,"
                " email_confirmed, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
                (role, nome, cognome, email, generate_password_hash(password), now_str()))
            print(f"[init] Creato utente {role}: {email} / {password}  (cambia la password!)")
    db.commit()
    db.close()


# ---------------------------------------------------------------- lingua

def current_lang():
    lang = session.get("lang")
    if lang in LANGS:
        return lang
    if g.get("user") is not None and g.user["lang"] in LANGS:
        return g.user["lang"]
    return DEFAULT_LANG


def t(key, lang=None, **kwargs):
    return translate(key, lang or current_lang(), **kwargs)


@app.route("/lingua/<code>")
def set_lang(code):
    if code in LANGS:
        session["lang"] = code
        if g.user is not None:
            db = get_db()
            db.execute("UPDATE users SET lang = ? WHERE id = ?", (code, g.user["id"]))
            db.commit()
    nxt = request.args.get("next", "")
    if not (nxt.startswith("/") and not nxt.startswith("//")):
        nxt = url_for("index")
    return redirect(nxt)


# ---------------------------------------------------------------- helpers

def ext_url(endpoint, **values):
    """URL assoluto: usa BASE_URL se impostato (necessario per QR ed email)."""
    if BASE_URL:
        return BASE_URL + url_for(endpoint, **values)
    return url_for(endpoint, _external=True, **values)


def send_mail(to, lang, subject_key, template, attachments=None, **ctx):
    """Invia un'email nella lingua del destinatario."""
    def tr(key, **kw):
        return translate(key, lang, **kw)
    subject = tr(subject_key, **ctx.get("subject_args", {}))
    html = render_template(template, t=tr, lang=lang, rtl=lang in RTL, **ctx)
    msg = EmailMessage()
    msg["From"] = MAIL_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(tr("mail_html_only"))
    msg.add_alternative(html, subtype="html")
    for filename, data, maintype, subtype in attachments or []:
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)

    if SMTP_HOST:
        port = int(os.environ.get("SMTP_PORT", "587"))
        user = os.environ.get("SMTP_USER")
        password = os.environ.get("SMTP_PASSWORD")
        try:
            if port == 465:
                server = smtplib.SMTP_SSL(SMTP_HOST, port, timeout=20)
            else:
                server = smtplib.SMTP(SMTP_HOST, port, timeout=20)
                server.starttls()
            with server:
                if user:
                    server.login(user, password)
                server.send_message(msg)
        except Exception as exc:  # non bloccare l'utente se l'SMTP fallisce
            app.logger.error("Invio email a %s fallito: %s", to, exc)
        return

    # Modalità sviluppo: niente SMTP, l'email finisce nella cartella data/outbox
    OUTBOX.mkdir(exist_ok=True)
    name = f"{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.eml"
    (OUTBOX / name).write_bytes(bytes(msg))
    print(f"[email] a {to}: {subject}  -> data/outbox/{name}")


def qr_for(shipment):
    return segno.make(ext_url("scan", token=shipment["qr_token"]), error="m")


def qr_png(shipment):
    buf = io.BytesIO()
    qr_for(shipment).save(buf, kind="png", scale=10, border=2)
    return buf.getvalue()


def new_shipment_code(db):
    prefix = "IXG-" + datetime.now().strftime("%y%m%d") + "-"
    while True:
        code = prefix + secrets.token_hex(2).upper()
        if not db.execute("SELECT 1 FROM shipments WHERE code = ?", (code,)).fetchone():
            return code


def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


@app.before_request
def before():
    g.user = None
    uid = session.get("uid")
    if uid:
        g.user = get_db().execute(
            "SELECT * FROM users WHERE id = ? AND active = 1", (uid,)).fetchone()
        if g.user is None:
            session.pop("uid", None)
    if request.method == "POST":
        if not secrets.compare_digest(request.form.get("_csrf", ""), session.get("csrf", "")):
            abort(400, t("err_csrf"))


@app.context_processor
def inject():
    lang = current_lang()
    return {"csrf_token": csrf_token, "STATUS": STATUS, "ROLES": ROLES, "LANGS": LANGS,
            "lang": lang, "rtl": lang in RTL, "t": t, "dev_mail": not SMTP_HOST}


@app.template_filter("it_date")
def it_date(value):
    if not value:
        return ""
    try:
        return datetime.strptime(value[:10], "%Y-%m-%d").strftime("%d/%m/%Y")
    except ValueError:
        return value


@app.template_filter("hm")
def hm(value):
    return value[11:16] if value and len(value) >= 16 else ""


def login_required(*roles):
    def deco(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if g.user is None:
                flash(t("flash_login_needed"), "info")
                return redirect(url_for("login", next=request.path))
            if roles and g.user["role"] not in roles:
                abort(403)
            return view(*args, **kwargs)
        return wrapped
    return deco


def is_staff():
    return g.user is not None and g.user["role"] in ("admin", "corriere")


def home_for(user):
    return {"admin": "admin_dashboard", "corriere": "courier_dashboard"}.get(
        user["role"], "client_dashboard")


def get_shipment_or_404(sid):
    s = get_db().execute("SELECT * FROM shipments WHERE id = ?", (sid,)).fetchone()
    if s is None:
        abort(404)
    if not is_staff() and s["user_id"] != g.user["id"]:
        abort(404)
    return s


def get_user(uid):
    return get_db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()


def clean(form, keys):
    return {k: (form.get(k) or "").strip() for k in keys}


def require(data, keys, errors):
    for key in keys:
        if not data.get(key):
            errors[key] = t("err_required")


# ---------------------------------------------------------------- pubbliche

@app.route("/")
def index():
    if g.user:
        return redirect(url_for(home_for(g.user)))
    return render_template("index.html")


REG_FIELDS = ["ragione_sociale", "nome", "cognome", "indirizzo", "cap", "citta",
              "provincia", "telefono", "email"]
REG_REQUIRED = ["nome", "cognome", "indirizzo", "cap", "citta", "telefono", "email"]


def validate_profile(data, errors):
    require(data, REG_REQUIRED, errors)
    if data.get("email") and not EMAIL_RE.match(data["email"]):
        errors["email"] = t("err_email")
    if data.get("telefono") and not PHONE_RE.match(data["telefono"]):
        errors["telefono"] = t("err_phone")
    if data.get("cap") and not ZIP_RE.match(data["cap"]):
        errors["cap"] = t("err_zip")


@app.route("/registrati", methods=["GET", "POST"])
def register():
    if g.user:
        return redirect(url_for("index"))
    data, errors = {}, {}
    if request.method == "POST":
        data = clean(request.form, REG_FIELDS)
        data["email"] = data["email"].lower()
        validate_profile(data, errors)
        password = request.form.get("password", "")
        if len(password) < 8:
            errors["password"] = t("err_password_len")
        elif password != request.form.get("password2", ""):
            errors["password2"] = t("err_password_match")
        if not request.form.get("privacy"):
            errors["privacy"] = t("err_privacy")
        db = get_db()
        if not errors.get("email") and db.execute(
                "SELECT 1 FROM users WHERE email = ?", (data["email"],)).fetchone():
            errors["email"] = t("err_email_taken")
        if not errors:
            token = secrets.token_urlsafe(32)
            lang = current_lang()
            db.execute(
                "INSERT INTO users (role, ragione_sociale, nome, cognome, indirizzo, cap,"
                " citta, provincia, telefono, email, password_hash, confirm_token, lang,"
                " created_at) VALUES ('cliente', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (data["ragione_sociale"] or None, data["nome"], data["cognome"],
                 data["indirizzo"], data["cap"], data["citta"], data["provincia"] or None,
                 data["telefono"], data["email"], generate_password_hash(password),
                 token, lang, now_str()))
            db.commit()
            send_mail(data["email"], lang, "mail_confirm_subject", "email/confirm.html",
                      nome=data["nome"], link=ext_url("confirm_email", token=token))
            return render_template("check_email.html", email=data["email"])
    return render_template("register.html", f=data, errors=errors)


@app.route("/conferma/<token>")
def confirm_email(token):
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE confirm_token = ?", (token,)).fetchone()
    if user is None:
        flash(t("flash_confirm_invalid"), "error")
        return redirect(url_for("login"))
    db.execute("UPDATE users SET email_confirmed = 1, confirm_token = NULL WHERE id = ?",
               (user["id"],))
    db.commit()
    flash(t("flash_confirm_ok"), "success")
    return redirect(url_for("login"))


@app.route("/reinvia-conferma", methods=["GET", "POST"])
def resend_confirmation():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        db = get_db()
        user = db.execute("SELECT * FROM users WHERE email = ? AND email_confirmed = 0",
                          (email,)).fetchone()
        if user:
            token = secrets.token_urlsafe(32)
            db.execute("UPDATE users SET confirm_token = ? WHERE id = ?", (token, user["id"]))
            db.commit()
            send_mail(email, user["lang"], "mail_confirm_subject", "email/confirm.html",
                      nome=user["nome"], link=ext_url("confirm_email", token=token))
        # risposta identica in ogni caso, per non rivelare quali email sono registrate
        return render_template("check_email.html", email=email)
    return render_template("resend.html")


@app.route("/accedi", methods=["GET", "POST"])
def login():
    if g.user:
        return redirect(url_for(home_for(g.user)))
    email = ""
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        user = get_db().execute("SELECT * FROM users WHERE email = ? AND active = 1",
                                (email,)).fetchone()
        if user is None or not check_password_hash(user["password_hash"],
                                                   request.form.get("password", "")):
            flash(t("flash_login_bad"), "error")
        elif not user["email_confirmed"]:
            flash(t("flash_login_unconfirmed"), "error")
            return render_template("login.html", email=email, show_resend=True)
        else:
            lang = session.get("lang")
            session.clear()
            session["uid"] = user["id"]
            if lang in LANGS:
                # la lingua scelta prima del login vince su quella salvata
                session["lang"] = lang
                if lang != user["lang"]:
                    db = get_db()
                    db.execute("UPDATE users SET lang = ? WHERE id = ?", (lang, user["id"]))
                    db.commit()
            nxt = request.args.get("next", "")
            if nxt.startswith("/") and not nxt.startswith("//"):
                return redirect(nxt)
            return redirect(url_for(home_for(user)))
    return render_template("login.html", email=email)


@app.route("/esci", methods=["POST"])
def logout():
    lang = session.get("lang")
    session.clear()
    if lang:
        session["lang"] = lang
    return redirect(url_for("index"))


@app.route("/profilo", methods=["GET", "POST"])
@login_required()
def profile():
    errors = {}
    data = dict(g.user)
    if request.method == "POST":
        db = get_db()
        if request.form.get("action") == "password":
            if not check_password_hash(g.user["password_hash"], request.form.get("old", "")):
                errors["old"] = t("err_old_password")
            elif len(request.form.get("new", "")) < 8:
                errors["new"] = t("err_password_len")
            else:
                db.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                           (generate_password_hash(request.form["new"]), g.user["id"]))
                db.commit()
                flash(t("flash_password_ok"), "success")
                return redirect(url_for("profile"))
        elif g.user["role"] == "cliente":
            data = clean(request.form, REG_FIELDS)
            data["email"] = g.user["email"]  # l'email non si cambia da qui
            validate_profile(data, errors)
            if not errors:
                db.execute(
                    "UPDATE users SET ragione_sociale=?, nome=?, cognome=?, indirizzo=?,"
                    " cap=?, citta=?, provincia=?, telefono=? WHERE id=?",
                    (data["ragione_sociale"] or None, data["nome"], data["cognome"],
                     data["indirizzo"], data["cap"], data["citta"], data["provincia"] or None,
                     data["telefono"], g.user["id"]))
                db.commit()
                flash(t("flash_profile_ok"), "success")
                return redirect(url_for("profile"))
    return render_template("profile.html", f=data, errors=errors)


# ---------------------------------------------------------------- cliente

@app.route("/area-cliente")
@login_required("cliente")
def client_dashboard():
    rows = get_db().execute(
        "SELECT * FROM shipments WHERE user_id = ? ORDER BY id DESC", (g.user["id"],)).fetchall()
    return render_template("client_dashboard.html", shipments=rows)


SHIP_FIELDS = [
    "mitt_ragione_sociale", "mitt_nome", "mitt_cognome", "mitt_telefono", "mitt_email",
    "pickup_date", "pickup_time", "pickup_indirizzo", "pickup_cap", "pickup_citta",
    "pickup_provincia", "dest_nome", "dest_indirizzo", "dest_cap", "dest_citta",
    "dest_provincia", "dest_ref_nome", "dest_ref_telefono", "tipo", "colli", "peso", "note",
]
SHIP_REQUIRED = [
    "mitt_nome", "mitt_cognome", "mitt_telefono", "mitt_email", "pickup_date",
    "pickup_time", "pickup_indirizzo", "pickup_cap", "pickup_citta", "dest_nome",
    "dest_indirizzo", "dest_cap", "dest_citta", "dest_ref_nome", "dest_ref_telefono", "tipo",
]


@app.route("/spedizioni/nuova", methods=["GET", "POST"])
@login_required("cliente")
def new_shipment():
    u = g.user
    errors = {}
    if request.method == "POST":
        data = clean(request.form, SHIP_FIELDS)
        require(data, SHIP_REQUIRED, errors)
        if data["mitt_email"] and not EMAIL_RE.match(data["mitt_email"]):
            errors["mitt_email"] = t("err_email")
        for key in ("mitt_telefono", "dest_ref_telefono"):
            if data[key] and not PHONE_RE.match(data[key]):
                errors[key] = t("err_phone")
        for key in ("pickup_cap", "dest_cap"):
            if data[key] and not ZIP_RE.match(data[key]):
                errors[key] = t("err_zip")
        if data["tipo"] and data["tipo"] not in ("busta", "pacco"):
            errors["tipo"] = t("err_required")
        try:
            colli = int(data["colli"] or 1)
            if not 1 <= colli <= 99:
                raise ValueError
        except ValueError:
            errors["colli"] = t("err_parcels")
            colli = 1
        if data["pickup_date"] and data["pickup_time"]:
            try:
                when = datetime.strptime(f"{data['pickup_date']} {data['pickup_time']}",
                                         "%Y-%m-%d %H:%M")
                if when < datetime.now():
                    errors["pickup_date"] = t("err_pickup_past")
            except ValueError:
                errors["pickup_date"] = t("err_datetime")
        if not errors:
            db = get_db()
            code = new_shipment_code(db)
            values = {k: (data[k] or None) for k in SHIP_FIELDS}
            values["colli"] = colli
            cols = ", ".join(SHIP_FIELDS)
            marks = ", ".join("?" for _ in SHIP_FIELDS)
            cur = db.execute(
                f"INSERT INTO shipments (code, qr_token, user_id, created_at, {cols})"
                f" VALUES (?, ?, ?, ?, {marks})",
                [code, secrets.token_urlsafe(16), u["id"], now_str()]
                + [values[k] for k in SHIP_FIELDS])
            db.commit()
            s = db.execute("SELECT * FROM shipments WHERE id = ?", (cur.lastrowid,)).fetchone()
            for admin in db.execute(
                    "SELECT email, lang FROM users WHERE role = 'admin' AND active = 1"):
                send_mail(admin["email"], admin["lang"], "mail_admin_new_subject",
                          "email/admin_new.html", s=s, subject_args={"code": code},
                          link=ext_url("shipment_detail", sid=s["id"]))
            flash(t("flash_shipment_sent", code=code), "success")
            return redirect(url_for("shipment_detail", sid=s["id"]))
    else:
        data = {
            "mitt_ragione_sociale": u["ragione_sociale"] or "", "mitt_nome": u["nome"],
            "mitt_cognome": u["cognome"], "mitt_telefono": u["telefono"] or "",
            "mitt_email": u["email"], "pickup_indirizzo": u["indirizzo"] or "",
            "pickup_cap": u["cap"] or "", "pickup_citta": u["citta"] or "",
            "pickup_provincia": u["provincia"] or "", "tipo": "pacco", "colli": "1",
            "pickup_date": date.today().isoformat(),
        }
    return render_template("new_shipment.html", f=data, errors=errors,
                           today=date.today().isoformat())


@app.route("/spedizioni/<int:sid>/annulla-richiesta", methods=["POST"])
@login_required("cliente")
def client_cancel(sid):
    s = get_shipment_or_404(sid)
    if s["status"] != "in_attesa":
        flash(t("flash_cancel_only_pending"), "error")
    else:
        db = get_db()
        db.execute("UPDATE shipments SET status = 'annullata', cancelled_at = ? WHERE id = ?",
                   (now_str(), sid))
        db.commit()
        flash(t("flash_cancelled", code=s["code"]), "success")
    return redirect(url_for("shipment_detail", sid=sid))


# ---------------------------------------------------------------- spedizione (tutti)

def full_name(uid):
    u = get_user(uid) if uid else None
    return f"{u['nome']} {u['cognome']}" if u else None


@app.route("/spedizioni/<int:sid>")
@login_required()
def shipment_detail(sid):
    s = get_shipment_or_404(sid)
    now = datetime.now()
    return render_template("shipment_detail.html", s=s, owner=get_user(s["user_id"]),
                           confirmed_by=full_name(s["confirmed_by"]),
                           delivered_by=full_name(s["delivered_by"]),
                           now_date=now.strftime("%Y-%m-%d"), now_time=now.strftime("%H:%M"))


@app.route("/spedizioni/<int:sid>/etichetta")
@login_required()
def shipment_label(sid):
    s = get_shipment_or_404(sid)
    if s["status"] not in ("confermata", "consegnata"):
        flash(t("flash_label_after_confirm"), "info")
        return redirect(url_for("shipment_detail", sid=sid))
    qr_svg = qr_for(s).svg_inline(scale=5, dark="#000", border=1)
    return render_template("label.html", s=s, qr_svg=qr_svg)


@app.route("/spedizioni/<int:sid>/qr.png")
@login_required()
def shipment_qr_png(sid):
    s = get_shipment_or_404(sid)
    if s["status"] not in ("confermata", "consegnata"):
        abort(404)
    return Response(qr_png(s), mimetype="image/png", headers={
        "Content-Disposition": f'attachment; filename="QR-{s["code"]}.png"'})


@app.route("/s/<token>")
def scan(token):
    """Pagina aperta scansionando il QR code sul pacco."""
    s = get_db().execute("SELECT * FROM shipments WHERE qr_token = ?", (token,)).fetchone()
    if s is None:
        abort(404)
    if is_staff() or (g.user and g.user["id"] == s["user_id"]):
        return redirect(url_for("shipment_detail", sid=s["id"]))
    return render_template("scan_public.html", s=s)


@app.route("/spedizioni/<int:sid>/consegna", methods=["POST"])
@login_required("admin", "corriere")
def mark_delivered(sid):
    s = get_shipment_or_404(sid)
    if s["status"] != "confermata":
        flash(t("flash_deliver_only_confirmed"), "error")
        return redirect(url_for("shipment_detail", sid=sid))
    try:
        when = datetime.strptime(
            f"{request.form.get('data', '')} {request.form.get('ora', '')}", "%Y-%m-%d %H:%M")
    except ValueError:
        flash(t("err_datetime"), "error")
        return redirect(url_for("shipment_detail", sid=sid))
    if (when - datetime.now()).total_seconds() > 300:
        flash(t("flash_deliver_future"), "error")
        return redirect(url_for("shipment_detail", sid=sid))
    db = get_db()
    db.execute("UPDATE shipments SET status = 'consegnata', delivered_at = ?, delivered_by = ?"
               " WHERE id = ?", (when.strftime("%Y-%m-%d %H:%M:00"), g.user["id"], sid))
    db.commit()
    s = db.execute("SELECT * FROM shipments WHERE id = ?", (sid,)).fetchone()
    owner = get_user(s["user_id"])
    send_mail(owner["email"], owner["lang"], "mail_delivered_subject", "email/delivered.html",
              s=s, nome=owner["nome"], subject_args={"code": s["code"]},
              link=ext_url("shipment_detail", sid=sid))
    flash(t("flash_delivered", date=when.strftime("%d/%m/%Y"), time=when.strftime("%H:%M")),
          "success")
    if g.user["role"] == "corriere":
        return redirect(url_for("courier_dashboard"))
    return redirect(url_for("shipment_detail", sid=sid))


# ---------------------------------------------------------------- admin

@app.route("/admin")
@login_required("admin")
def admin_dashboard():
    status = request.args.get("stato", "in_attesa")
    q = request.args.get("q", "").strip()
    db = get_db()
    sql = "SELECT s.* FROM shipments s"
    where, params = [], []
    if status in STATUS:
        where.append("s.status = ?")
        params.append(status)
    if q:
        like = f"%{q}%"
        where.append("(s.code LIKE ? OR s.mitt_ragione_sociale LIKE ? OR s.mitt_cognome LIKE ?"
                     " OR s.dest_nome LIKE ? OR s.dest_citta LIKE ?)")
        params += [like] * 5
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY s.pickup_date, s.pickup_time" if status in ("in_attesa", "confermata") \
        else " ORDER BY s.id DESC"
    rows = db.execute(sql, params).fetchall()
    counts = {r["status"]: r["n"] for r in db.execute(
        "SELECT status, COUNT(*) AS n FROM shipments GROUP BY status")}
    return render_template("admin/dashboard.html", shipments=rows, status=status, q=q,
                           counts=counts)


@app.route("/admin/spedizioni/<int:sid>/conferma", methods=["POST"])
@login_required("admin")
def admin_confirm(sid):
    s = get_shipment_or_404(sid)
    if s["status"] != "in_attesa":
        flash(t("flash_not_pending"), "error")
        return redirect(url_for("shipment_detail", sid=sid))
    db = get_db()
    db.execute("UPDATE shipments SET status = 'confermata', confirmed_at = ?, confirmed_by = ?"
               " WHERE id = ?", (now_str(), g.user["id"], sid))
    db.commit()
    s = db.execute("SELECT * FROM shipments WHERE id = ?", (sid,)).fetchone()
    owner = get_user(s["user_id"])
    send_mail(owner["email"], owner["lang"], "mail_confirmed_subject", "email/confirmed.html",
              nome=owner["nome"], s=s, subject_args={"code": s["code"]},
              link=ext_url("shipment_label", sid=sid),
              attachments=[(f"QR-{s['code']}.png", qr_png(s), "image", "png")])
    flash(t("flash_confirmed", code=s["code"]), "success")
    return redirect(url_for("shipment_detail", sid=sid))


@app.route("/admin/spedizioni/<int:sid>/annulla", methods=["POST"])
@login_required("admin")
def admin_cancel(sid):
    s = get_shipment_or_404(sid)
    if s["status"] not in ("in_attesa", "confermata"):
        flash(t("flash_cannot_cancel"), "error")
        return redirect(url_for("shipment_detail", sid=sid))
    db = get_db()
    db.execute("UPDATE shipments SET status = 'annullata', cancelled_at = ? WHERE id = ?",
               (now_str(), sid))
    db.commit()
    owner = get_user(s["user_id"])
    send_mail(owner["email"], owner["lang"], "mail_cancelled_subject", "email/cancelled.html",
              nome=owner["nome"], s=s, subject_args={"code": s["code"]},
              motivo=request.form.get("motivo", "").strip())
    flash(t("flash_cancelled", code=s["code"]), "success")
    return redirect(url_for("shipment_detail", sid=sid))


@app.route("/admin/utenti", methods=["GET", "POST"])
@login_required("admin")
def admin_users():
    db = get_db()
    errors, f = {}, {}
    if request.method == "POST":
        action = request.form.get("action")
        if action == "toggle":
            uid = int(request.form.get("uid", 0))
            if uid != g.user["id"]:
                db.execute("UPDATE users SET active = 1 - active WHERE id = ?", (uid,))
                db.commit()
            return redirect(url_for("admin_users"))
        f = clean(request.form, ["role", "nome", "cognome", "email", "telefono"])
        f["email"] = f["email"].lower()
        require(f, ["nome", "cognome", "email"], errors)
        if f["role"] not in ("admin", "corriere"):
            errors["role"] = t("err_required")
        if f["email"] and not EMAIL_RE.match(f["email"]):
            errors["email"] = t("err_email")
        elif db.execute("SELECT 1 FROM users WHERE email = ?", (f["email"],)).fetchone():
            errors["email"] = t("err_email_taken")
        password = request.form.get("password", "")
        if len(password) < 8:
            errors["password"] = t("err_password_len")
        if not errors:
            db.execute(
                "INSERT INTO users (role, nome, cognome, email, telefono, password_hash,"
                " email_confirmed, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
                (f["role"], f["nome"], f["cognome"], f["email"], f["telefono"] or None,
                 generate_password_hash(password), current_lang(), now_str()))
            db.commit()
            flash(t("flash_user_created", name=f"{f['nome']} {f['cognome']}"), "success")
            return redirect(url_for("admin_users"))
    staff = db.execute("SELECT * FROM users WHERE role IN ('admin', 'corriere')"
                       " ORDER BY role, cognome").fetchall()
    clients = db.execute(
        "SELECT u.*, (SELECT COUNT(*) FROM shipments s WHERE s.user_id = u.id) AS n"
        " FROM users u WHERE role = 'cliente' ORDER BY u.id DESC").fetchall()
    return render_template("admin/users.html", staff=staff, clients=clients, f=f, errors=errors)


# ---------------------------------------------------------------- corriere

@app.route("/corriere")
@login_required("corriere", "admin")
def courier_dashboard():
    db = get_db()
    todo = db.execute("SELECT * FROM shipments WHERE status = 'confermata'"
                      " ORDER BY pickup_date, pickup_time").fetchall()
    done = db.execute("SELECT * FROM shipments WHERE status = 'consegnata'"
                      " AND date(delivered_at) = date('now', 'localtime')"
                      " ORDER BY delivered_at DESC").fetchall()
    return render_template("courier_dashboard.html", todo=todo, done=done)


# ---------------------------------------------------------------- posta (sviluppo)

@app.route("/dev/posta")
def dev_mailbox():
    if SMTP_HOST:
        abort(404)
    mails = []
    if OUTBOX.exists():
        for path in sorted(OUTBOX.glob("*.eml"), reverse=True)[:50]:
            msg = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
            mails.append({"id": path.stem, "to": msg["To"], "subject": msg["Subject"]})
    return render_template("dev_mailbox.html", mails=mails)


@app.route("/dev/posta/<mail_id>")
def dev_mail(mail_id):
    if SMTP_HOST or not re.match(r"^[\w-]+$", mail_id):
        abort(404)
    path = OUTBOX / f"{mail_id}.eml"
    if not path.exists():
        abort(404)
    msg = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
    body = msg.get_body(preferencelist=("html",))
    return Response(body.get_content(), mimetype="text/html")


@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
def http_error(err):
    return render_template("error.html", code=err.code,
                           message=getattr(err, "description", "") if err.code == 400 else ""), \
        err.code


init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
