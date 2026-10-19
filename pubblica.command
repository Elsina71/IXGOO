#!/bin/sh
# Doppio clic per pubblicare IxGoo online (regole Firestore + sito).
# Serve firebase-key.json in questa cartella.
cd "$(dirname "$0")"
if ! .venv/bin/python -c "import google.auth, requests" 2>/dev/null; then
  rm -rf .venv
  python3 -m venv .venv && .venv/bin/pip install -q google-auth requests
fi
.venv/bin/python -W ignore tools/deploy.py
echo
read -p "Premi Invio per chiudere" _
