#!/bin/sh
# Avvia IxGoo. Crea (o ricrea, se la cartella è stata spostata) l'ambiente Python.
cd "$(dirname "$0")"
if ! .venv/bin/python -c "import flask, segno" 2>/dev/null; then
  rm -rf .venv
  python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
fi
exec .venv/bin/python app.py
