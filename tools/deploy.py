"""Pubblica IxGoo su Firebase senza la riga di comando di Firebase.

Usa la chiave del service account (firebase-key.json, mai su GitHub) per:
  1. pubblicare le regole di sicurezza di Firestore (firestore.rules)
  2. creare, se manca, il sito Hosting indicato in firebase.json
  3. caricare la cartella public/ e metterla online

Avvio:  ./pubblica.command   (oppure: tools/.venv/bin/python tools/deploy.py)
"""
import gzip
import hashlib
import json
import sys
from pathlib import Path

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

ROOT = Path(__file__).resolve().parent.parent
KEY = ROOT / "firebase-key.json"
HOSTING = "https://firebasehosting.googleapis.com/v1beta1"
RULES = "https://firebaserules.googleapis.com/v1"


def session():
    if not KEY.exists():
        sys.exit("Manca firebase-key.json nella cartella del progetto.")
    creds = service_account.Credentials.from_service_account_file(
        str(KEY), scopes=["https://www.googleapis.com/auth/cloud-platform",
                          "https://www.googleapis.com/auth/firebase"])
    return AuthorizedSession(creds), json.loads(KEY.read_text())["project_id"]


def check(resp, what):
    if not resp.ok:
        sys.exit(f"Errore durante {what}: {resp.status_code} {resp.text[:500]}")
    return resp.json() if resp.content else {}


def deploy_rules(s, project):
    source = (ROOT / "firestore.rules").read_text()
    ruleset = check(s.post(f"{RULES}/projects/{project}/rulesets", json={
        "source": {"files": [{"name": "firestore.rules", "content": source}]}}),
        "la verifica delle regole")["name"]
    name = f"projects/{project}/releases/cloud.firestore"
    check(s.patch(f"{RULES}/{name}", json={"release": {"name": name, "rulesetName": ruleset}}),
          "la pubblicazione delle regole")
    print("✓ Regole Firestore pubblicate")


def ensure_site(s, project, site):
    r = s.get(f"{HOSTING}/projects/{project}/sites/{site}")
    if r.ok:
        return r.json()["defaultUrl"]
    r = s.post(f"{HOSTING}/projects/{project}/sites", params={"siteId": site}, json={})
    if r.status_code in (400, 409):
        sys.exit(f"Il nome di sito '{site}' non è disponibile ({r.json().get('error', {}).get('message')}).\n"
                 f"Scegline un altro e cambialo in firebase.json alla voce \"site\".")
    print(f"✓ Creato il sito Hosting '{site}'")
    return check(r, "la creazione del sito")["defaultUrl"]


def deploy_hosting(s, project):
    cfg = json.loads((ROOT / "firebase.json").read_text())["hosting"]
    site = cfg["site"]
    url = ensure_site(s, project, site)
    public = ROOT / cfg["public"]

    headers = [{"glob": h["source"], "headers": {x["key"]: x["value"] for x in h["headers"]}}
               for h in cfg.get("headers", [])]
    version = check(s.post(f"{HOSTING}/sites/{site}/versions",
                           json={"config": {"headers": headers}}), "la creazione della versione")["name"]

    files, blobs = {}, {}
    for path in sorted(public.rglob("*")):
        if path.is_dir() or any(part.startswith(".") for part in path.relative_to(public).parts):
            continue
        data = gzip.compress(path.read_bytes(), mtime=0)
        digest = hashlib.sha256(data).hexdigest()
        files["/" + path.relative_to(public).as_posix()] = digest
        blobs[digest] = data
    pop = check(s.post(f"{HOSTING}/{version}:populateFiles", json={"files": files}),
                "l'elenco dei file")
    upload_url = pop.get("uploadUrl")
    for digest in pop.get("uploadRequiredHashes", []):
        check(s.post(f"{upload_url}/{digest}", data=blobs[digest],
                     headers={"Content-Type": "application/octet-stream"}), "il caricamento dei file")
    check(s.patch(f"{HOSTING}/{version}", params={"update_mask": "status"},
                  json={"status": "FINALIZED"}), "la chiusura della versione")
    check(s.post(f"{HOSTING}/sites/{site}/releases", params={"versionName": version}, json={}),
          "la pubblicazione del sito")
    print(f"✓ Sito pubblicato ({len(files)} file): {url}")
    return url


if __name__ == "__main__":
    sess, project = session()
    deploy_rules(sess, project)
    deploy_hosting(sess, project)
