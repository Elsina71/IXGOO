# IxGoo Courier & Logistics — prenotazione spedizioni

**Online:** https://ixgoo.web.app

App statica, gratuita (piano Firebase Spark): Firebase Authentication + Firestore + Firebase Hosting.
Lingua principale greco; anche inglese, italiano, francese, ebraico (da destra a sinistra),
spagnolo, tedesco, russo e cinese.

## Flusso

1. Il cliente si registra (ragione sociale facoltativa, referente, indirizzo, telefono, email) e
   conferma l'email con il link che Firebase gli invia.
2. Prenota: mittente, data/ora e luogo di ritiro, destinatario con referente e telefono, busta o pacco.
3. L'admin vede l'ordine in "Ordini" e preme **Conferma ricevimento ordine**.
4. Nell'area del cliente compare subito il QR code con l'etichetta da stampare e attaccare al pacco.
5. Il corriere scansiona il QR (si apre la spedizione, dopo il login) e preme
   **"Consegna effettuata il giorno … alle ore …"**. Il cliente vede la consegna nella sua area.

## Ruoli

- `ixgoo@outlook.com.gr` e `pierpaolomurgioni@gmail.com` diventano **admin** quando si registrano
  (lista in `public/js/app.js` e `firestore.rules`).
- Corrieri e altri admin si registrano come clienti; poi un admin cambia il loro ruolo da **Utenti**.
- In alternativa, da questa cartella: `.venv/bin/python tools/admin.py ruolo <email> corriere`

## Pubblicare una modifica

Doppio clic su **`pubblica.command`** (oppure `.venv/bin/python tools/deploy.py`).
Pubblica regole di sicurezza e sito usando `firebase-key.json` (chiave del service account,
**mai su GitHub**: è nel `.gitignore`). Nel browser premi ⌘⇧R per vedere subito la nuova versione.

## File

- `public/` — il sito: `index.html`, `style.css`, `js/app.js` (tutta l'app), `js/i18n.js`
  (traduzioni), `js/firebase-config.js` (configurazione web, pubblica per natura)
- `firestore.rules` — regole di sicurezza: chi può leggere e modificare cosa
- `tools/deploy.py` — pubblicazione; `tools/admin.py` — cambio ruoli

## Dati (Firestore)

- `users/{uid}` — profilo e ruolo di ogni account
- `shipments/{codice}` — spedizioni; l'ID è il codice `IXG-AAMMGG-XXXXXX`

La versione precedente con server Python (Cloud Run) è nel ramo `versione-server`.
