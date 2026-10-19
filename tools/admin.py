"""Operazioni di amministrazione con la chiave del service account.

  tools/admin.py ruolo <email> <cliente|corriere|admin>   cambia il ruolo di un account
  tools/admin.py pulizia                                   elimina i profili della vecchia versione con server

Il primo admin si nomina da qui: dopo, gli altri ruoli si cambiano dall'app (pagina Utenti).
"""
import sys

from deploy import check, session

FIRESTORE = "https://firestore.googleapis.com/v1"
AUTH = "https://identitytoolkit.googleapis.com/v1"


def set_role(s, project, email, role):
    if role not in ("cliente", "corriere", "admin"):
        sys.exit("Ruolo non valido: usa cliente, corriere o admin.")
    users = check(s.post(f"{AUTH}/projects/{project}/accounts:lookup",
                         json={"email": [email.lower()]}), "la ricerca dell'account").get("users")
    if not users:
        sys.exit(f"Nessun account registrato con {email}.")
    uid = users[0]["localId"]
    name = f"projects/{project}/databases/(default)/documents/users/{uid}"
    check(s.patch(f"{FIRESTORE}/{name}", params={"updateMask.fieldPaths": ["role", "active"],
                                                   "currentDocument.exists": "true"},
                  json={"fields": {"role": {"stringValue": role}, "active": {"booleanValue": True}}}),
          "l'aggiornamento del profilo")
    print(f"✓ {email} ora è {role}")


def cleanup(s, project):
    base = f"{FIRESTORE}/projects/{project}/databases/(default)/documents/users"
    docs = check(s.get(base, params={"pageSize": 300}), "la lettura degli utenti").get("documents", [])
    old = [d["name"] for d in docs if "password_hash" in d.get("fields", {})]
    for name in old:
        check(s.delete(f"{FIRESTORE}/{name}"), "l'eliminazione")
    print(f"✓ Eliminati {len(old)} profili della vecchia versione")


if __name__ == "__main__":
    sess, proj = session()
    if len(sys.argv) == 4 and sys.argv[1] == "ruolo":
        set_role(sess, proj, sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 2 and sys.argv[1] == "pulizia":
        cleanup(sess, proj)
    else:
        sys.exit(__doc__)
