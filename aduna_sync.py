"""
Aduna-Abgleich für das Kundenportal - läuft im Büro-Netz von Clean Service.

Holt alle Portal-Meldungen, die noch nicht in Aduna stehen, schreibt sie in
Aduna und meldet das Ergebnis ans Portal zurück. Gedacht für die Windows-
Aufgabenplanung, z.B. alle 5 Minuten.

    python aduna_sync.py            # echter Lauf
    python aduna_sync.py --probe    # zeigt nur, was geschrieben WÜRDE

Einrichtung:
    pip install requests pyodbc
    Umgebungsvariablen (oder Datei .env neben diesem Skript):
      PORTAL_URL        https://portal.clean-service.ch
      ADUNA_SYNC_KEY    derselbe Wert wie bei Vercel
      ADUNA_SQL         ODBC-Verbindungszeichenfolge zum Aduna-SQL-Server, z.B.
                        DRIVER={ODBC Driver 18 for SQL Server};SERVER=ADUNA01;DATABASE=Aduna;Trusted_Connection=yes;TrustServerCertificate=yes

OFFEN - wird mit dem Aduna-Support (Version 26.1) festgelegt:
    Die genauen Tabellen/Felder in tpeDisposition (Absage, Verschiebung) und
    tTagesjournal (Reklamation, Schaden). Die Stellen sind unten mit
    "ADUNA-MAPPING" markiert. Bis dahin läuft das Skript nur mit --probe.
"""

import os
import sys
import json
import requests

HIER = os.path.dirname(os.path.abspath(__file__))


def env_laden():
    pfad = os.path.join(HIER, ".env")
    if os.path.exists(pfad):
        for zeile in open(pfad, encoding="utf-8"):
            if "=" in zeile and not zeile.strip().startswith("#"):
                k, v = zeile.strip().split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


env_laden()
PORTAL = os.environ.get("PORTAL_URL", "").rstrip("/")
KEY = os.environ.get("ADUNA_SYNC_KEY", "")
SQL = os.environ.get("ADUNA_SQL", "")
PROBE = "--probe" in sys.argv


def portal(methode, action, daten=None):
    r = requests.request(
        methode, f"{PORTAL}/api/aduna?action={action}",
        headers={"X-Api-Key": KEY, "Content-Type": "application/json"},
        data=json.dumps(daten) if daten else None, timeout=30,
    )
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------- ADUNA-MAPPING
# Pro Kategorie eine Funktion. Jede bekommt die Meldung (dict) und einen
# offenen DB-Cursor und gibt eine Referenz zurück (z.B. die neue ID in Aduna).
# Die Felder der Meldung: objekt_id, termin_datum, termin_neu, zeitraum_bis,
# reinigungsdatum, reklamation_wunsch, verrechnung, details, name, email.

def absage(m, cur):
    # Einzeltermin: termin_datum. Abwesenheit: termin_datum bis zeitraum_bis.
    # verrechnung: "kostenlos" | "50" | "100" | "pruefen"
    raise NotImplementedError("ADUNA-MAPPING: tpeDisposition für Absage festlegen")


def verschiebung(m, cur):
    # termin_datum entfällt bei der festen Raumpflegerin,
    # termin_neu wird dem Springerteam zugeteilt.
    raise NotImplementedError("ADUNA-MAPPING: tpeDisposition für Verschiebung festlegen")


def reklamation(m, cur):
    # reklamation_wunsch: "nachreinigung" (Springerteam, Zeit der Raumpflegerin
    # abziehen) oder "gespraech" (Rückruf Abteilungsleiter)
    raise NotImplementedError("ADUNA-MAPPING: tTagesjournal für Reklamation festlegen")


def schaden(m, cur):
    raise NotImplementedError("ADUNA-MAPPING: tTagesjournal für Schaden festlegen")


SCHREIBER = {"absage": absage, "verschiebung": verschiebung,
             "reklamation": reklamation, "schaden": schaden}
# ------------------------------------------------------------------------------


def main():
    if not PORTAL or not KEY:
        sys.exit("PORTAL_URL und ADUNA_SYNC_KEY müssen gesetzt sein.")

    meldungen = portal("GET", "ausstehend")["meldungen"]
    print(f"{len(meldungen)} Meldung(en) offen")
    if not meldungen:
        return

    if PROBE:
        for m in meldungen:
            print(f"  #{m['id']} {m['kategorie']:<12} Objekt {m['objekt_id']}  "
                  f"{m.get('termin_datum') or m.get('reinigungsdatum')}  {m['name']}")
        print("Probelauf - nichts geschrieben.")
        return

    import pyodbc
    verbindung = pyodbc.connect(SQL, autocommit=False)
    ergebnisse = []
    for m in meldungen:
        cur = verbindung.cursor()
        try:
            ref = SCHREIBER[m["kategorie"]](m, cur)
            verbindung.commit()
            ergebnisse.append({"id": m["id"], "ok": True, "aduna_ref": ref})
        except Exception as e:  # eine fehlerhafte Meldung stoppt die anderen nicht
            verbindung.rollback()
            ergebnisse.append({"id": m["id"], "ok": False, "fehler": str(e)[:400]})
    verbindung.close()

    antwort = portal("POST", "rueckmeldung", {"ergebnisse": ergebnisse})
    print(f"Übertragen: {antwort['uebertragen']}, Fehler: {antwort['fehler']}")


if __name__ == "__main__":
    main()
