# Messa online — https://ixgoo.web.app

Architettura:

    ixgoo.web.app (Firebase Hosting)  →  Cloud Run "ixgoo" (europe-west1)  →  Firestore
                                          ↑ si aggiorna da solo a ogni push su GitHub (main)

`www.ixgoo.web.app` non è possibile: i domini `.web.app` sono di Google e Firebase assegna solo
`<nome>.web.app`. Per un indirizzo con "www" serve un dominio proprio (es. `www.ixgoo.gr`), che si
collega in seguito da Firebase Hosting → "Aggiungi dominio personalizzato".

## 1. Piano Blaze (una volta)

Cloud Run richiede il piano a consumo. Console Firebase → progetto IXGOO → in basso a sinistra
**Upgrade** → **Blaze** → collega un account di fatturazione. Per un piccolo corriere il traffico
resta quasi sempre nella quota gratuita. Consigliato: imposta un **avviso di budget** (es. 10 €).

## 2. Servizio Cloud Run collegato a GitHub (una volta)

1. Apri https://console.cloud.google.com/run?project=ixgoo-9f901
2. **Deploy container** → **Service**.
3. Scegli **Continuously deploy from a repository** → **Set up with Cloud Build**.
   - Provider: **GitHub** → autorizza → repository **Elsina71/IXGOO**.
   - Branch: `^main$` — Build type: **Dockerfile** (percorso `/Dockerfile`).
4. **Service name**: `ixgoo` — **Region**: `europe-west1 (Belgium)`.
   (Nome e regione devono restare questi: sono scritti in `firebase.json`.)
5. **Authentication**: **Allow public access** (è un sito pubblico; l'accesso è gestito dall'app).
6. **Containers → Variables & secrets**: aggiungi le variabili che trovi nel file locale
   `deploy-secrets.txt` (non è su GitHub):
   - `SECRET_KEY` = valore dal file
   - `BASE_URL` = `https://ixgoo.web.app`
7. **Create**. La prima build dura qualche minuto.

Firestore: su Cloud Run l'app usa le credenziali del servizio, non serve caricare `firebase-key.json`.

## 3. Sito Firebase Hosting `ixgoo` (una volta)

Console Firebase → **Hosting** → (Inizia) → **Aggiungi un altro sito** → ID sito: `ixgoo`.
Se `ixgoo` è già preso da qualcun altro, scegli un altro nome e aggiorna `"site"` in `firebase.json`.

## 4. Collegare ixgoo.web.app a Cloud Run (una volta, dal Mac)

Serve lo strumento `firebase` da riga di comando:

    firebase login
    firebase deploy --only hosting

(da questa cartella). Da qui in poi gli aggiornamenti dell'app arrivano online con un semplice
`git push`: Cloud Build ricostruisce il servizio, l'indirizzo non cambia.

## 5. Email (necessario per le registrazioni)

Senza server SMTP le email di conferma non partono e i clienti non possono attivare l'account.
In Cloud Run → servizio `ixgoo` → **Edit & deploy new revision** → Variables & secrets:

    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, MAIL_FROM

(Per le password è meglio usare **Reference a secret** di Secret Manager invece di una variabile.)

## 6. Prima di aprire ai clienti

- Accedi su https://ixgoo.web.app come `admin@ixgoo.gr` e `courier@ixgoo.gr` e **cambia le
  password** dal Profilo (quelle iniziali sono pubbliche nel README).
- Prova una registrazione completa con la tua email.
