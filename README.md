# Kundenportal Putzfrauenservice — Clean Service Scaramuzzo AG

Ein Kundenportal mit Anmeldung. Kundinnen und Kunden melden Terminverschiebungen,
Absagen, Reklamationen, Schäden und Zusatzarbeiten selbst — statt per E-Mail.

## Anmeldung

- **Anmelde-ID** ist die E-Mail-Adresse
- **Erstpasswort** entsteht bei Vertragsabschluss und steht auf dem Vertrag
- Beim ersten Anmelden muss ein **eigenes Passwort** gesetzt werden
- **Passwort vergessen** läuft selbstständig per E-Mail-Link (1 Stunde gültig)
- Nach 5 Fehlversuchen ist ein Konto 15 Minuten gesperrt
- Angemeldet bleibt man 30 Tage

Passwörter werden mit scrypt gehasht (in Node eingebaut). Jedes Konto hat einen
eigenen Zufallssalt; im Klartext wird nichts gespeichert.

## Geschäftsregeln (Stand 23.09.2026, alle in `api/_regeln.js`)

- **Absage:** automatisch bestätigt. Frist gemäss AGB Ziff. 4: ab 24 Std. vorher kostenlos, darunter 50 %, unter 4 Std. 100 %. Ohne genaue Einsatzzeit prüft das Portal beide Ränder des Einsatzfensters (08–17 Uhr). Ist das Ergebnis nicht eindeutig, wird die Absage mit „prüfen“ markiert.
- **Ferien:** Absage als Zeitraum von–bis, ohne Maximum. Zählt nicht in die Ampel.
- **Verschiebung:** automatisch bestätigt, Ersatztermin durch das Springerteam (frühestens morgen). Keine Verschiebung mit der festen Raumpflegerin.
- **Reklamation:** nur innert 24 Std. (Reinigung von heute oder gestern). Die Kundschaft wählt zwischen Nachreinigung durch das Springerteam (interne Notiz: Zeit wird der fixen Raumpflegerin abgezogen) und Gespräch mit dem Abteilungsleiter.
- **Zusatzarbeiten:** Mail „Offerte vorbereiten“ an spezialreinigung@. Erscheint nicht im PFS-Posteingang.
- **Bestätigung:** Jede Meldung löst sofort eine Bestätigungsmail an die Kundschaft aus.
- **Beekeeper:** Nur Absagen und Verschiebungen gehen in den Chat der Raumpflegerin.
- **Admin:** Ein gemeinsames Passwort, beim Anmelden wählt man seinen Namen. Bearbeiter und Notiz-Autor werden automatisch eingetragen.

## Rollout Bestandskunden

Adminbereich → Kundenkonten → „Rollout Bestandskunden“:
1. CSV importieren (Objektnummer; Name; E-Mail; Adresse). Bestehende Konten werden nicht überschrieben.
2. „Nächste Welle senden“: pro Klick bis 100 Kunden. Jede Mail enthält ein frisch erzeugtes Erstpasswort. Wer schon eine Mail erhalten hat, bekommt keine zweite.

## Aduna-Abgleich

Aduna läuft On-Premise. `aduna-sync/aduna_sync.py` läuft im Büro-Netz (Windows-Aufgabenplanung, alle 5 Min.), holt über `/api/aduna` alle Meldungen mit `aduna_status = ausstehend`, schreibt sie in Aduna und meldet das Ergebnis zurück. In der Firewall muss dafür nichts geöffnet werden. Offen ist nur noch das Feld-Mapping für tpeDisposition/tTagesjournal (im Skript mit „ADUNA-MAPPING“ markiert), das mit dem Aduna-Support festgelegt wird.

## Dateien

```
index.html              Kundenansicht: Anmeldung + Meldeformulare
admin.html              Adminbereich für das PFS-Team
api/konto.js            Anmelden, Passwort setzen, Passwort vergessen
api/aduna.js            Abgleich mit Aduna (Pull durch aduna-sync)
api/_regeln.js          Geschäftsregeln (Fristen, Verrechnung, Prüfungen)
api/_meldung-pdf.js     PDF für Reklamation/Schaden auf Briefpapier
aduna-sync/             Skript für den Aduna-Server im Büro
api/zugang.js           Konto anlegen (wird von der Angebots-App aufgerufen)
api/melde.js            Meldungen entgegennehmen (Supabase + E-Mail + Beekeeper)
api/admin.js            Adminfunktionen
supabase_schema.sql     Datenbankschema
```

## Umgebungsvariablen bei Vercel

```
SUPABASE_URL
SUPABASE_SERVICE_KEY
RESEND_API_KEY
SESSION_SECRET          langer Zufallswert, signiert die Anmelde-Cookies
PORTAL_URL              https://portal.clean-service.ch
ADMIN_PASSWORD
TURNSTILE_SECRET_KEY
BEEKEEPER_TENANT_URL
BEEKEEPER_API_TOKEN
ANGEBOT_API_KEY         gemeinsamer Schlüssel mit der Angebots-App
ADUNA_SYNC_KEY          gemeinsamer Schlüssel mit aduna-sync
ADMIN_NAMEN             optional, kommagetrennt (Standard: Cristian Gambale, Fiorella Scalone, Tayron Moreno, Lina)
```

## Einrichtung

1. `supabase_schema.sql` in Supabase ausführen
2. Umgebungsvariablen bei Vercel setzen
3. Domain `portal.clean-service.ch` verbinden
4. In der Angebots-App `PORTAL_URL` und `PORTAL_API_KEY` setzen
   (`PORTAL_API_KEY` = derselbe Wert wie `ANGEBOT_API_KEY` hier)

## Offen

- Aduna-Feld-Mapping (Support-Termin Version 26.1)
- Domain portal.clean-service.ch (IT)
- Beekeeper-Bot in die Kunden-Gruppenchats aufnehmen (Lernende)
- AGB: Portal als offiziellen Kanal aufnehmen
