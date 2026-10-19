# Immagine per Google Cloud Run
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run passa la porta nella variabile PORT (di solito 8080)
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 60 app:app
