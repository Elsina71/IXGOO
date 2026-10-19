# IxGoo Courier & Logistics — prenotazione spedizioni

Web app per prenotare ritiri e consegne. Lingua principale greco; disponibile anche in
inglese, italiano, francese, ebraico (layout da destra a sinistra), spagnolo, tedesco, russo e cinese.

## Avvio

    ./run.sh

Poi apri http://localhost:5050. La prima volta crea l'ambiente Python e installa Flask e segno (QR).

Account creati al primo avvio (cambia subito le password da "Profilo"):

| Ruolo     | Email             | Password    |
|-----------|-------------------|-------------|
| Admin     | admin@ixgoo.gr    | admin123    |
| Corriere  | courier@ixgoo.gr  | courier123  |

Dall'area **Utenti** l'admin crea altri corrieri o amministratori.

## Flusso

1. Il cliente si registra (ragione sociale facoltativa, referente, indirizzo, telefono, email) e conferma l'email.
2. Prenota una spedizione: mittente, data/ora e luogo di ritiro, destinatario con referente e telefono, busta o pacco.
3. L'admin riceve un'email e conferma il ricevimento dell'ordine.
4. Il cliente riceve l'email con il QR code allegato e il link all'etichetta da stampare.
5. Il corriere scansiona il QR (apre la scheda della spedizione) e preme
   "Consegna effettuata il giorno … alle ore …". Il cliente riceve la notifica.

Ogni utente riceve le email nella lingua che ha scelto.

## Configurazione (file `.env`, vedi `.env.example`)

- `BASE_URL` — indirizzo pubblico dell'app. **Necessario in produzione**: è l'URL dentro il QR
  code e nei link delle email (con `localhost` il telefono del corriere non lo raggiunge).
- `SMTP_*` — server di posta. Senza `SMTP_HOST` le email non vengono inviate ma salvate in
  `data/outbox/` e si leggono su `/dev/posta` (utile per provare).

## File

- `app.py` — tutta la logica (rotte, database SQLite in `data/ixgoo.db`, email, QR)
- `i18n.py` — tutte le traduzioni (una riga per lingua per ogni testo)
- `templates/` — pagine ed email; `static/` — stile e logo
