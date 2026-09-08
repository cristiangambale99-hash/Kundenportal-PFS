# Kundenportal — Clean Service Scaramuzzo AG

Kundenportal für den Putzfrauenservice: Kundinnen und Kunden melden Terminverschiebungen,
Absagen, Reklamationen, Schäden und Zusatzaufträge direkt über die Webseite, statt per E-Mail.

## Aufbau

Bewusst flach gehalten — nur ein einziger Unterordner (`api/`), damit sich das
Projekt problemlos über die GitHub-Weboberfläche hochladen lässt.

```
index.html            Kundenansicht
admin.html            Admin-Dashboard (Passwort-geschützt)
logo.webp             Logo (freigestellt)
drop.webp             Bildmarke
package.json
vercel.json
supabase_schema.sql   Datenbankstruktur
api/melde.js          Nimmt Meldungen entgegen (Supabase + E-Mail + Beekeeper)
api/admin.js          Alle Admin-Funktionen (login, list, customers, stats, reply)
```

## Umgebungsvariablen (Vercel → Settings → Environment Variables)

| Variable | Zweck |
|---|---|
| `SUPABASE_URL` | Projekt-URL aus Supabase |
| `SUPABASE_SERVICE_KEY` | Service-Role-Key aus Supabase |
| `RESEND_API_KEY` | E-Mail-Versand über Resend |
| `BEEKEEPER_TENANT_URL` | z.B. `https://clean-service.ch.beekeeper.io` |
| `BEEKEEPER_API_TOKEN` | Bot-Token mit Admin-Rechten |
| `ADMIN_PASSWORD` | Passwort für `/admin.html` |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile (Captcha) |

## Einrichtung

1. Inhalt von `supabase_schema.sql` im Supabase SQL-Editor ausführen
2. Umgebungsvariablen bei Vercel eintragen
3. Repo mit Vercel verbinden — Deployment läuft automatisch

## Objekt-/Kundennummern

Das Portal akzeptiert nur Nummern, die in der Tabelle `objekt_beekeeper_mapping`
hinterlegt sind. Diese wird aus dem Aduna-Export befüllt; dort steht auch die
Beekeeper-Gruppenchat-ID, in die automatische Nachrichten gepostet werden.

## Offene Punkte

- Aduna-Anbindung (Version 26.1, Termin mit Yuma Bruggmann ausstehend)
- Foto-Upload bei Reklamation/Schaden wird noch nicht gespeichert
- Beekeeper-Bot muss manuell zu jedem Kunden-Gruppenchat hinzugefügt werden
