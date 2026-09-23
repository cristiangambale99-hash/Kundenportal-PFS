/**
 * /api/aduna — Abgleich mit Aduna (Pull-Prinzip).
 *
 * Aduna läuft lokal bei Clean Service (On-Premise, SQL Server). Statt den
 * SQL-Server ins Internet zu öffnen, holt ein kleines Skript im Büro-Netz
 * (aduna-sync/aduna_sync.py) die offenen Meldungen hier ab, schreibt sie in
 * Aduna und meldet das Ergebnis zurück. In der Firewall muss nichts geöffnet
 * werden.
 *
 *   GET  /api/aduna?action=ausstehend            -> offene Meldungen (max. 100)
 *   POST /api/aduna?action=rueckmeldung          { ergebnisse: [{ id, ok, aduna_ref?, fehler? }] }
 *
 * Absicherung: Header X-Api-Key = ADUNA_SYNC_KEY (Vercel-Umgebungsvariable).
 */

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

let _client = null;
function getSupabase() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY sind nicht gesetzt.");
    _client = createClient(url, key);
  }
  return _client;
}

function berechtigt(req) {
  const soll = (process.env.ADUNA_SYNC_KEY || "").trim();
  const ist = String(req.headers["x-api-key"] || "").trim();
  if (!soll || !ist) return false;
  const a = Buffer.from(soll), b = Buffer.from(ist);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const FELDER = [
  "id", "kategorie", "objekt_id", "name", "adresse", "email",
  "termin_datum", "termin_neu", "zeitraum_bis", "reinigungsdatum",
  "reklamation_wunsch", "verrechnung", "vorlauf_stunden",
  "details", "created_at", "aduna_status", "aduna_fehler",
].join(", ");

module.exports = async function handler(req, res) {
  if (!process.env.ADUNA_SYNC_KEY) {
    res.status(503).json({ error: "Aduna-Abgleich ist noch nicht eingerichtet (ADUNA_SYNC_KEY fehlt)." });
    return;
  }
  if (!berechtigt(req)) { res.status(401).json({ error: "Nicht berechtigt." }); return; }

  const supabase = getSupabase();
  const action = (req.query && req.query.action) || "";

  if (action === "ausstehend" && req.method === "GET") {
    const { data, error } = await supabase
      .from("meldungen").select(FELDER)
      .in("aduna_status", ["ausstehend", "fehler"])
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ meldungen: data || [] });
    return;
  }

  if (action === "rueckmeldung" && req.method === "POST") {
    const ergebnisse = Array.isArray((req.body || {}).ergebnisse) ? req.body.ergebnisse : [];
    let ok = 0, fehler = 0;
    for (const e of ergebnisse.slice(0, 200)) {
      if (!e || !e.id) continue;
      const felder = e.ok
        ? { aduna_status: "uebertragen", aduna_ref: e.aduna_ref ? String(e.aduna_ref) : null,
            aduna_uebertragen_am: new Date().toISOString(), aduna_fehler: null }
        : { aduna_status: "fehler", aduna_fehler: String(e.fehler || "unbekannt").slice(0, 500) };
      const { error } = await supabase.from("meldungen").update(felder).eq("id", e.id);
      if (error) fehler++; else if (e.ok) ok++; else fehler++;
    }
    res.status(200).json({ ok: true, uebertragen: ok, fehler });
    return;
  }

  res.status(400).json({ error: "Unbekannter Aufruf." });
};
