/**
 * /api/zugang — persönlicher Kundenzugang ohne Passwort.
 *
 *   GET  /api/zugang?token=7FQ2-XR91    Kundendaten zum Zugangslink holen
 *   POST /api/zugang?action=anfordern   { email }  Link erneut zusenden
 *
 * Warum kein Passwort: Bei rund 550 Privathaushalten - viele davon ältere
 * Kundinnen und Kunden - erzeugen vergessene Passwörter mehr Aufwand fürs
 * Team, als das Portal an Mailverkehr einspart. Der Zugangslink kommt mit der
 * Auftragserteilung (als Link und QR-Code) und funktioniert dauerhaft.
 */

const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

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

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

const PORTAL_URL = (process.env.PORTAL_URL || "https://kundenportal-two.vercel.app").replace(/\/$/, "");

/** Max. 3 Link-Anforderungen pro E-Mail und Stunde. */
async function zuVieleAnfragen(supabase, email) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("zugang_versand")
    .select("id", { count: "exact", head: true })
    .ilike("email", email)
    .gte("created_at", since);
  return (count || 0) >= 3;
}

async function sendeZugangsMail(email, name, token) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY ist nicht gesetzt.");
  const link = `${PORTAL_URL}/k/${token}`;

  const html = `
    <p>Guten Tag ${name || ""}</p>
    <p>Hier ist Ihr persönlicher Zugang zum Kundenportal:</p>
    <p style="margin:22px 0;">
      <a href="${link}" style="background:#2bb6b7; color:#ffffff; text-decoration:none;
         padding:14px 24px; border-radius:9px; font-weight:600; display:inline-block;">
        Kundenportal öffnen
      </a>
    </p>
    <p style="font-size:13px; color:#5b6b76;">
      Oder diesen Link im Browser öffnen:<br>
      <a href="${link}">${link}</a>
    </p>
    <p style="font-size:13px; color:#5b6b76;">
      Sie brauchen kein Passwort. Speichern Sie den Link als Lesezeichen, dann sind
      Ihre Angaben beim nächsten Mal bereits ausgefüllt.
    </p>
    <p style="color:#7c8c8b; font-size:12.5px; margin-top:26px;">
      Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · 0844 355 355
    </p>
  `;

  return new Resend(apiKey).emails.send({
    from: "Clean Service Scaramuzzo AG <kundenportal@clean-service.ch>",
    to: email,
    subject: "Ihr Zugang zum Kundenportal",
    html,
  });
}

module.exports = async function handler(req, res) {
  const supabase = getSupabase();
  const action = (req.query && req.query.action) || "";

  /* --- Zugangsdaten zu einem Token holen --- */
  if (req.method === "GET") {
    const token = (req.query.token || "").trim().toUpperCase();
    if (!token) { res.status(400).json({ error: "Kein Token angegeben." }); return; }

    const { data, error } = await supabase
      .from("kundenzugaenge")
      .select("token, objekt_id, name, email, adresse, aktiv")
      .eq("token", token)
      .maybeSingle();

    if (error) { res.status(500).json({ error: error.message }); return; }
    if (!data || !data.aktiv) {
      res.status(404).json({ error: "Dieser Zugangslink ist nicht (mehr) gültig." });
      return;
    }

    // Nutzung protokollieren (nice-to-have, darf nie blockieren)
    supabase.from("kundenzugaenge")
      .update({ letzte_nutzung: new Date().toISOString() })
      .eq("token", token)
      .then(() => {}, () => {});

    res.status(200).json({
      objekt_id: data.objekt_id,
      name: data.name,
      email: data.email,
      adresse: data.adresse,
    });
    return;
  }

  /* --- Zugangslink erneut zusenden --- */
  if (req.method === "POST" && action === "anfordern") {
    const email = ((req.body || {}).email || "").trim();
    if (!email || !email.includes("@")) {
      res.status(400).json({ error: "Bitte geben Sie eine gültige E-Mail-Adresse an." });
      return;
    }

    if (await zuVieleAnfragen(supabase, email)) {
      res.status(429).json({
        error: "Es wurden bereits mehrere Links an diese Adresse geschickt. Bitte prüfen Sie Ihren Posteingang oder rufen Sie uns an: 0844 355 355.",
      });
      return;
    }

    await supabase.from("zugang_versand").insert({ email, ip: getClientIp(req) });

    const { data } = await supabase
      .from("kundenzugaenge")
      .select("token, name, email, aktiv")
      .ilike("email", email)
      .eq("aktiv", true)
      .maybeSingle();

    if (data) {
      try { await sendeZugangsMail(data.email, data.name, data.token); }
      catch (err) { console.error("Zugangsmail fehlgeschlagen:", err.message); }
    }

    // Bewusst immer dieselbe Antwort: sonst liesse sich herausfinden,
    // welche Adressen bei uns Kunde sind.
    res.status(200).json({
      ok: true,
      hinweis: "Falls diese Adresse bei uns hinterlegt ist, haben wir Ihnen soeben Ihren Zugangslink geschickt.",
    });
    return;
  }

  res.status(400).json({ error: "Unbekannter Aufruf." });
};
