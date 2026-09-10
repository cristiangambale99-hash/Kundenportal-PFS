/**
 * /api/admin — sammelt alle Admin-Funktionen in einer Datei.
 *
 * Aufruf über den Parameter "action":
 *   POST /api/admin?action=login      { password }
 *   GET  /api/admin?action=list       [&kategorie=..&status=..]
 *   GET  /api/admin?action=customers  (pro Kunde gruppiert, mit Ampel)
 *   GET  /api/admin?action=stats      (Kennzahlen der letzten 30 Tage)
 *   POST /api/admin?action=reply      { id, action: akzeptieren|ablehnen|erledigt|nachricht, nachricht }
 *
 * Bewusst in einer Datei zusammengefasst, damit das Projekt ohne verschachtelte
 * Ordner auskommt und sich leicht hochladen lässt.
 */

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

/* ---------------------------------------------------------------- Supabase */
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

/* -------------------------------------------------------------- Anmeldung */
const COOKIE_NAME = "admin_session";
const SESSION_HOURS = 12;

function sign(value) {
  return crypto.createHmac("sha256", process.env.ADMIN_PASSWORD || "").update(value).digest("hex");
}

function createSessionCookie() {
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const value = `${expires}.${sign(String(expires))}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
}

function isValidSession(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.split(";").map(c => c.trim()).find(c => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return false;
  const [expires, signature] = match.split("=")[1].split(".");
  if (!expires || !signature) return false;
  if (sign(expires) !== signature) return false;
  return Date.now() <= Number(expires);
}

/* ------------------------------------------------------------------ E-Mail */
const KATEGORIE_LABEL = {
  verschiebung: "Terminverschiebung",
  absage: "Absage",
  reklamation: "Reklamation",
  schaden: "Schadenmeldung",
  zusatz: "Zusatzauftrag-Anfrage",
};

async function sendeAdminAntwort({ email, name, betreff, nachricht }) {
  if (!email) throw new Error("Keine E-Mail-Adresse für diese Meldung hinterlegt.");
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY ist nicht gesetzt.");

  const html = `
    <p>Guten Tag ${name || ""}</p>
    <p style="white-space:pre-wrap;">${nachricht}</p>
    <p style="color:#767676; font-size:13px; margin-top:24px;">
      Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · 0844 355 355
    </p>
  `;
  return new Resend(apiKey).emails.send({
    from: "Clean Service Scaramuzzo AG <kundenportal@clean-service.ch>",
    to: email,
    subject: betreff || "Rückmeldung zu Ihrer Meldung",
    html,
  });
}


/* ------------------------------------------------------- Kundenzugaenge */
// Gut lesbares Format, ohne leicht verwechselbare Zeichen (kein O/0, I/1)
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeToken() {
  const pick = n => Array.from({ length: n }, () =>
    TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)]).join("");
  return `${pick(4)}-${pick(4)}`;
}

const PORTAL_URL = (process.env.PORTAL_URL || "https://kundenportal-two.vercel.app").replace(/\/$/, "");

async function sendeZugangsMail(email, name, token) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY ist nicht gesetzt.");
  const link = `${PORTAL_URL}/k/${token}`;
  const html = `
    <p>Guten Tag ${name || ""}</p>
    <p>Herzlich willkommen bei Clean Service Scaramuzzo AG. Hier ist Ihr persönlicher
       Zugang zum Kundenportal — damit melden Sie Termine, Absagen oder Anliegen
       direkt bei uns, ohne E-Mail schreiben zu müssen.</p>
    <p style="margin:22px 0;">
      <a href="${link}" style="background:#2bb6b7; color:#ffffff; text-decoration:none;
         padding:14px 24px; border-radius:9px; font-weight:600; display:inline-block;">
        Kundenportal öffnen
      </a>
    </p>
    <p style="font-size:13px; color:#5b6b76;">
      Oder diesen Link im Browser öffnen:<br><a href="${link}">${link}</a>
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

/* ------------------------------------------------------------------- Ampel */
/**
 * ROT   - mind. 3 Reklamationen/Schäden in 90 Tagen ODER eine Absage in 30 Tagen
 * GELB  - 1-2 Reklamationen/Schäden in 90 Tagen ODER 2+ Verschiebungen in 90 Tagen
 * GRÜN  - alles andere
 */
function berechneAmpel(meldungen) {
  const jetzt = Date.now();
  const tage = (m) => (jetzt - new Date(m.created_at).getTime()) / 86400000;

  const rs90 = meldungen.filter(m => (m.kategorie === "reklamation" || m.kategorie === "schaden") && tage(m) <= 90).length;
  const absagen30 = meldungen.filter(m => m.kategorie === "absage" && tage(m) <= 30).length;
  const versch90 = meldungen.filter(m => m.kategorie === "verschiebung" && tage(m) <= 90).length;

  if (rs90 >= 3 || absagen30 >= 1) return "rot";
  if (rs90 >= 1 || versch90 >= 2) return "gelb";
  return "gruen";
}

const STANDARD_TEXTE = {
  akzeptieren: "Ihr Wunschtermin wurde bestätigt.",
  ablehnen: "Leider können wir Ihren Wunschtermin nicht wie gewünscht anbieten. Wir melden uns mit einem Alternativvorschlag.",
  erledigt: "Ihre Meldung wurde bearbeitet und ist damit abgeschlossen.",
};

/* ----------------------------------------------------------------- Handler */
module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || "";

  /* --- Anmelden (einzige Aktion ohne bestehende Sitzung) --- */
  if (action === "login") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const expected = (process.env.ADMIN_PASSWORD || "").trim();
    const eingegeben = ((req.body || {}).password || "").trim();

    if (!expected) { res.status(500).json({ error: "ADMIN_PASSWORD ist serverseitig nicht gesetzt." }); return; }
    if (eingegeben !== expected) {
      res.status(401).json({
        error: "Falsches Passwort.",
        diagnose: `eingegeben: ${eingegeben.length} Zeichen, erwartet: ${expected.length} Zeichen`,
      });
      return;
    }
    res.setHeader("Set-Cookie", createSessionCookie());
    res.status(200).json({ ok: true });
    return;
  }

  /* --- Ab hier ist eine gültige Sitzung Pflicht --- */
  if (!isValidSession(req)) { res.status(401).json({ error: "Nicht angemeldet." }); return; }

  const supabase = getSupabase();

  /* --- Liste aller Meldungen --- */
  if (action === "list") {
    let query = supabase.from("meldungen").select("*").order("created_at", { ascending: false }).limit(200);
    if (req.query.kategorie) query = query.eq("kategorie", req.query.kategorie);
    if (req.query.status) query = query.eq("status", req.query.status);
    const { data, error } = await query;
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ meldungen: data });
    return;
  }

  /* --- Pro Kunde gruppiert, mit Ampel-Einschätzung --- */
  if (action === "customers") {
    const { data: meldungen, error } = await supabase
      .from("meldungen").select("*").order("created_at", { ascending: false });
    if (error) { res.status(500).json({ error: error.message }); return; }

    const proKunde = {};
    for (const m of meldungen) {
      if (!proKunde[m.objekt_id]) {
        proKunde[m.objekt_id] = { objekt_id: m.objekt_id, name: m.name, email: m.email, meldungen: [] };
      }
      proKunde[m.objekt_id].meldungen.push(m);
    }

    const kunden = Object.values(proKunde).map(k => {
      const zaehler = { verschiebung: 0, absage: 0, reklamation: 0, schaden: 0, zusatz: 0 };
      let offen = 0;
      for (const m of k.meldungen) {
        zaehler[m.kategorie] = (zaehler[m.kategorie] || 0) + 1;
        if (!m.status || m.status === "neu") offen++;
      }
      return {
        objekt_id: k.objekt_id, name: k.name, email: k.email,
        total: k.meldungen.length, offen, zaehler,
        letzte_meldung: k.meldungen[0].created_at,
        ampel: berechneAmpel(k.meldungen),
        meldungen: k.meldungen,
      };
    });

    const rang = { rot: 0, gelb: 1, gruen: 2 };
    kunden.sort((a, b) =>
      rang[a.ampel] !== rang[b.ampel]
        ? rang[a.ampel] - rang[b.ampel]
        : new Date(b.letzte_meldung) - new Date(a.letzte_meldung));

    res.status(200).json({ kunden });
    return;
  }

  /* --- Kennzahlen der letzten 30 Tage --- */
  if (action === "stats") {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: meldungen, error } = await supabase
      .from("meldungen").select("kategorie, status, created_at").gte("created_at", since);
    if (error) { res.status(500).json({ error: error.message }); return; }

    const proKategorie = {}, proTag = {};
    let offen = 0;
    for (const m of meldungen) {
      proKategorie[m.kategorie] = (proKategorie[m.kategorie] || 0) + 1;
      const tag = m.created_at.slice(0, 10);
      proTag[tag] = (proTag[tag] || 0) + 1;
      if (!m.status || m.status === "neu") offen++;
    }

    const { count: fehlversuche } = await supabase
      .from("fehlversuche").select("id", { count: "exact", head: true }).gte("created_at", since);

    res.status(200).json({
      zeitraum_tage: 30, total: meldungen.length, offen,
      pro_kategorie: proKategorie, pro_tag: proTag,
      fehlgeschlagene_versuche: fehlversuche || 0,
    });
    return;
  }

  /* --- Antworten / Status setzen --- */
  if (action === "reply") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const { id, action: aktion, nachricht } = req.body || {};
    if (!id || !aktion) { res.status(400).json({ error: "id und action sind erforderlich." }); return; }

    const { data: meldung, error: fetchError } = await supabase
      .from("meldungen").select("*").eq("id", id).single();
    if (fetchError || !meldung) { res.status(404).json({ error: "Meldung nicht gefunden." }); return; }

    const neuerStatus = aktion === "nachricht" ? meldung.status : aktion;
    const text = nachricht || STANDARD_TEXTE[aktion] || "";
    const label = KATEGORIE_LABEL[meldung.kategorie] || meldung.kategorie;

    let mailStatus = "skipped", mailError = null;
    if (text) {
      try {
        await sendeAdminAntwort({
          email: meldung.email, name: meldung.name,
          betreff: `Rückmeldung zu Ihrer ${label}`, nachricht: text,
        });
        mailStatus = "sent";
      } catch (err) {
        mailStatus = "error";
        mailError = err.message;
        // Eine fehlgeschlagene Mail blockiert den Bearbeitungsstatus nicht.
      }
    }

    const { error: updateError } = await supabase
      .from("meldungen")
      .update({ status: neuerStatus, admin_note: text || meldung.admin_note })
      .eq("id", id);
    if (updateError) { res.status(500).json({ error: updateError.message }); return; }

    res.status(200).json({ ok: true, mail: mailStatus, mail_error: mailError });
    return;
  }

  /* --- Kundenzugang anlegen und Link verschicken --- */
  if (action === "zugang-anlegen") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const { objekt_id, name, email, adresse, senden } = req.body || {};
    if (!objekt_id || !name || !email) {
      res.status(400).json({ error: "objekt_id, name und email sind erforderlich." });
      return;
    }

    // Bestehenden aktiven Zugang wiederverwenden statt doppelt anlegen
    const { data: vorhanden } = await supabase
      .from("kundenzugaenge").select("token").eq("objekt_id", objekt_id).eq("aktiv", true).maybeSingle();

    let token = vorhanden?.token;
    if (!token) {
      token = makeToken();
      const { error } = await supabase.from("kundenzugaenge")
        .insert({ token, objekt_id, name, email, adresse: adresse || null });
      if (error) { res.status(500).json({ error: error.message }); return; }
    }

    let mail = "skipped", mailError = null;
    if (senden !== false) {
      try { await sendeZugangsMail(email, name, token); mail = "sent"; }
      catch (err) { mail = "error"; mailError = err.message; }
    }

    res.status(200).json({ ok: true, token, link: `${PORTAL_URL}/k/${token}`, mail, mail_error: mailError });
    return;
  }

  /* --- Alle Kundenzugaenge auflisten --- */
  if (action === "zugaenge") {
    const { data, error } = await supabase
      .from("kundenzugaenge")
      .select("token, objekt_id, name, email, aktiv, letzte_nutzung, erstellt_am")
      .order("erstellt_am", { ascending: false })
      .limit(600);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ zugaenge: data, portal_url: PORTAL_URL });
    return;
  }

  /* --- Zugang deaktivieren (z.B. bei Kündigung) --- */
  if (action === "zugang-deaktivieren") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const { token } = req.body || {};
    if (!token) { res.status(400).json({ error: "token ist erforderlich." }); return; }
    const { error } = await supabase.from("kundenzugaenge").update({ aktiv: false }).eq("token", token);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).json({ error: `Unbekannte action: "${action}"` });
};
