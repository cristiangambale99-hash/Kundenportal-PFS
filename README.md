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

## Dateien

```
index.html              Kundenansicht: Anmeldung + Meldeformulare
admin.html              Adminbereich für das PFS-Team
api/konto.js            Anmelden, Passwort setzen, Passwort vergessen
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
```

## Einrichtung

1. `supabase_schema.sql` in Supabase ausführen
2. Umgebungsvariablen bei Vercel setzen
3. Domain `portal.clean-service.ch` verbinden
4. In der Angebots-App `PORTAL_URL` und `PORTAL_API_KEY` setzen
   (`PORTAL_API_KEY` = derselbe Wert wie `ANGEBOT_API_KEY` hier)

## Offen

- Konten für die rund 550 Bestandskunden anlegen und Zugangsdaten verteilen
- Im Adminbereich eine Möglichkeit ergänzen, ein Passwort von Hand zurückzusetzen
- Foto-Upload bei Reklamation und Schaden (Feld vorhanden, Speicherort fehlt)
