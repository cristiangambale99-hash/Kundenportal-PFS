/**
 * /api/zugang — Kundenkonto bei Vertragsabschluss anlegen.
 *
 *   POST /api/zugang?action=aus-angebot   (Header X-Api-Key)
 *     { objekt_id, name, email, adresse }
 *   -> { ok, anmeldeId, erstpasswort }
 *
 * Das Erstpasswort wird auf den Vertrag gedruckt. Beim ersten Anmelden muss die
 * Kundschaft ein eigenes Passwort setzen (siehe konto.js).
 *
 * Aufgerufen von der Angebots-Webapp, abgesichert ueber einen gemeinsamen
 * Schluessel im Header X-Api-Key.
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

/* Erstpasswort: gut lesbar, ohne verwechselbare Zeichen (kein O/0, kein I/1),
   damit es sich vom Vertrag abtippen laesst. */
const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function erstpasswortErzeugen() {
  const teil = n => Array.from({ length: n }, () =>
    PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)]).join("");
  return `${teil(4)}-${teil(4)}`;
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashen(passwort, salt) {
  return crypto.scryptSync(String(passwort), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString("hex");
}

module.exports = async function handler(req, res) {
  const supabase = getSupabase();
  const action = (req.query && req.query.action) || "";

  if (req.method !== "POST" || action !== "aus-angebot") {
    res.status(400).json({ ok: false, error: "Unbekannter Aufruf." });
    return;
  }

  const erwartet = (process.env.ANGEBOT_API_KEY || "").trim();
  const gesendet = (req.headers["x-api-key"] || "").trim();
  if (!erwartet) { res.status(500).json({ ok: false, error: "ANGEBOT_API_KEY ist serverseitig nicht gesetzt." }); return; }
  if (gesendet !== erwartet) { res.status(401).json({ ok: false, error: "Nicht berechtigt." }); return; }

  const { objekt_id, name, email, adresse } = req.body || {};
  if (!objekt_id || !name || !email) {
    res.status(400).json({ ok: false, error: "objekt_id, name und email sind erforderlich." });
    return;
  }

  const mail = String(email).trim().toLowerCase();

  try {
    // Konto zu dieser E-Mail schon vorhanden? Dann nicht ueberschreiben -
    // sonst wuerde ein neuer Vertrag das selbstgewaehlte Passwort loeschen.
    const { data: vorhanden } = await supabase
      .from("kundenzugaenge")
      .select("id, passwort_gesetzt")
      .ilike("email", mail)
      .maybeSingle();

    if (vorhanden) {
      if (vorhanden.passwort_gesetzt) {
        // Kundschaft hat bereits ein eigenes Passwort - unangetastet lassen.
        res.status(200).json({
          ok: true, anmeldeId: mail, erstpasswort: null, bestehend: true,
        });
        return;
      }
      // Konto existiert, aber Erstpasswort noch nicht eingeloest: neu erzeugen.
      const pw = erstpasswortErzeugen();
      const salt = crypto.randomBytes(16).toString("hex");
      await supabase.from("kundenzugaenge").update({
        objekt_id: String(objekt_id), name, adresse: adresse || null,
        passwort_salt: salt, passwort_hash: hashen(pw, salt),
        passwort_gesetzt: false, aktiv: true,
      }).eq("id", vorhanden.id);

      res.status(200).json({ ok: true, anmeldeId: mail, erstpasswort: pw });
      return;
    }

    const pw = erstpasswortErzeugen();
    const salt = crypto.randomBytes(16).toString("hex");
    const { error } = await supabase.from("kundenzugaenge").insert({
      objekt_id: String(objekt_id),
      name,
      email: mail,
      adresse: adresse || null,
      passwort_salt: salt,
      passwort_hash: hashen(pw, salt),
      passwort_gesetzt: false,
      aktiv: true,
    });

    if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
    res.status(200).json({ ok: true, anmeldeId: mail, erstpasswort: pw });

  } catch (err) {
    console.error("zugang.js:", err);
    res.status(500).json({ ok: false, error: "Konto konnte nicht angelegt werden." });
  }
};
