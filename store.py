"""Archivio dati dell'app.

- Firestore (produzione): attivo quando esiste la chiave del service account
  (variabile FIREBASE_CREDENTIALS, predefinito: firebase-key.json nella cartella).
- Memoria (solo prove): se la chiave manca. I dati si perdono al riavvio.

Collezioni Firestore:
    users/{id auto}        -> account di clienti, admin e corrieri
    shipments/{codice}     -> spedizioni, l'ID del documento è il codice IXG-...

Le query usano solo filtri di uguaglianza su un campo, così Firestore non
richiede indici composti; l'ordinamento si fa in Python.
"""
import copy
import os
import uuid
import warnings


class Collection:
    def get(self, doc_id):
        raise NotImplementedError

    def find(self, **equals):
        raise NotImplementedError

    def all(self):
        return self.find()

    def find_one(self, **equals):
        rows = self.find(**equals)
        return rows[0] if rows else None

    def add(self, data, doc_id=None):
        """Crea un documento. Con doc_id esplicito restituisce None se esiste già."""
        raise NotImplementedError

    def update(self, doc_id, data):
        raise NotImplementedError


# ---------------------------------------------------------------- memoria

class MemoryCollection(Collection):
    def __init__(self):
        self.docs = {}

    def get(self, doc_id):
        doc = self.docs.get(doc_id)
        return dict(copy.deepcopy(doc), id=doc_id) if doc is not None else None

    def find(self, **equals):
        return [dict(copy.deepcopy(d), id=k) for k, d in self.docs.items()
                if all(d.get(f) == v for f, v in equals.items())]

    def add(self, data, doc_id=None):
        doc_id = doc_id or uuid.uuid4().hex[:20]
        if doc_id in self.docs:
            return None
        self.docs[doc_id] = copy.deepcopy(data)
        return doc_id

    def update(self, doc_id, data):
        self.docs[doc_id].update(copy.deepcopy(data))


# ---------------------------------------------------------------- Firestore

class FirestoreCollection(Collection):
    def __init__(self, client, name):
        self.ref = client.collection(name)

    @staticmethod
    def _row(snap):
        return dict(snap.to_dict(), id=snap.id)

    def get(self, doc_id):
        snap = self.ref.document(doc_id).get()
        return self._row(snap) if snap.exists else None

    def find(self, **equals):
        from google.cloud.firestore_v1.base_query import FieldFilter
        query = self.ref
        for field, value in equals.items():
            query = query.where(filter=FieldFilter(field, "==", value))
        return [self._row(s) for s in query.stream()]

    def add(self, data, doc_id=None):
        from google.api_core.exceptions import AlreadyExists
        if doc_id is None:
            _, ref = self.ref.add(data)
            return ref.id
        try:
            self.ref.document(doc_id).create(data)
        except AlreadyExists:
            return None
        return doc_id

    def update(self, doc_id, data):
        self.ref.document(doc_id).update(data)


class Store:
    def __init__(self, users, shipments, backend):
        self.users = users
        self.shipments = shipments
        self.backend = backend


def open_store(base_dir):
    key = os.environ.get("FIREBASE_CREDENTIALS") or os.path.join(base_dir, "firebase-key.json")
    # su Cloud Run (K_SERVICE) si usano le credenziali del servizio, senza file chiave
    use_adc = os.environ.get("FIRESTORE_USE_ADC") == "1" or bool(os.environ.get("K_SERVICE"))
    if os.path.exists(key) or use_adc:
        warnings.filterwarnings("ignore", category=FutureWarning, module=r"google\..*")
        from google.cloud import firestore
        database = os.environ.get("FIRESTORE_DATABASE", "(default)")
        if os.path.exists(key):
            client = firestore.Client.from_service_account_json(key, database=database)
        else:  # es. su Cloud Run, con le credenziali del servizio
            client = firestore.Client(database=database)
        return Store(FirestoreCollection(client, "users"),
                     FirestoreCollection(client, "shipments"),
                     f"firestore:{client.project}/{database}")
    return Store(MemoryCollection(), MemoryCollection(), "memory")
