/**
 * POST /api/melde — nimmt eine Meldung aus dem Kundenportal entgegen.
 *
 * Ablauf:
 *   0. Anmeldung prüfen (die Sitzung ersetzt das frühere Captcha)
 *   1. In Supabase speichern (Tabelle "meldungen", Status "neu")
 *   2. Interne E-Mail an putzfrauenservice@clean-service.ch
 *   3. Bei Absagen sofort eine Bestätigung an den Kunden
 *   4. Beekeeper-Nachricht in den passenden Gruppenchat (best effort)
 *
 * Alle Hilfsfunktionen sind bewusst in dieser Datei zusammengefasst, damit das
 * Projekt ohne verschachtelte Ordner auskommt und sich leicht hochladen lässt.
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


/* -------------------------------------------------------------- Rate-Limit */
const RATE_LIMIT = 5;          // max. Meldungen ...
const RATE_WINDOW_MINUTES = 60; // ... pro Stunde und IP-Adresse

async function checkRateLimit(supabase, ip) {
  if (!ip) return { allowed: true };
  const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("meldungen")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("created_at", since);
  if (error) return { allowed: true }; // im Zweifel nie eine echte Meldung blockieren
  return { allowed: (count || 0) < RATE_LIMIT, count: count || 0 };
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

/* ------------------------------------------------------------- Monitoring */
async function logFehlversuch(supabase, { kategorie, grund, ip }) {
  try {
    await supabase.from("fehlversuche").insert({ kategorie: kategorie || null, grund, ip });
  } catch {
    // Monitoring darf die eigentliche Anfrage nie zum Absturz bringen.
  }
}

/* ------------------------------------------------------------------ E-Mail */
const KATEGORIE_LABEL = {
  verschiebung: "Terminverschiebung",
  absage: "Absage",
  reklamation: "Reklamation",
  schaden: "Schadenmeldung",
  zusatz: "Zusatzauftrag-Anfrage",
};

const NAECHSTE_SCHRITTE = {
  verschiebung: "Wir prüfen Ihren Wunschtermin und melden uns per E-Mail, sobald er bestätigt ist.",
  absage: "Die Absage ist hiermit bestätigt.",
  reklamation: "Wir melden uns innert 2 Arbeitstagen mit einer Rückmeldung zu Ihrer Reklamation.",
  schaden: "Wir melden uns innert 2 Arbeitstagen mit einer ersten Einschätzung.",
  zusatz: "Wir melden uns mit einer Offerte bzw. einem Terminvorschlag.",
};

function resendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY ist nicht gesetzt.");
  return new Resend(apiKey);
}

async function sendeTeamMail(meldung) {
  const resend = resendClient();
  const label = KATEGORIE_LABEL[meldung.kategorie] || meldung.kategorie;
  const html = `
    <h2>${label} über das Kundenportal</h2>
    <p><strong>Name:</strong> ${meldung.name || "-"}</p>
    <p><strong>Objekt-/Kundennummer:</strong> ${meldung.objekt_id || "— nicht angegeben"}</p>
    <p><strong>Adresse:</strong> ${meldung.adresse || "-"}</p>
    ${meldung.zuordnung_offen ? '<p style="color:#b3541e;"><strong>Zuordnung offen — bitte Kunde manuell zuordnen.</strong></p>' : ""}
    <p><strong>E-Mail:</strong> ${meldung.email || "-"}</p>
    <p><strong>Kategorie:</strong> ${label}</p>
    <pre style="white-space:pre-wrap; font-family:inherit;">${meldung.details || ""}</pre>
  `;
  return resend.emails.send({
    from: "Kundenportal <kundenportal@clean-service.ch>",
    to: "putzfrauenservice@clean-service.ch",
    subject: `[Kundenportal] ${label} – ${meldung.name || meldung.objekt_id || "Kunde"}`,
    html,
  });
}

async function sendeKundenBestaetigung(meldung) {
  if (!meldung.email) return { skipped: true, reason: "keine E-Mail-Adresse angegeben" };
  const resend = resendClient();
  const label = KATEGORIE_LABEL[meldung.kategorie] || meldung.kategorie;
  const html = `
    <p>Guten Tag ${meldung.name || ""}</p>
    <p>Wir haben Ihre Meldung <strong>„${label}"</strong> erhalten.</p>
    <p>${NAECHSTE_SCHRITTE[meldung.kategorie] || ""}</p>
    <p style="color:#767676; font-size:13px; margin-top:24px;">
      Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · 0844 355 355
    </p>
  `;
  return resend.emails.send({
    from: "Clean Service Scaramuzzo AG <kundenportal@clean-service.ch>",
    to: meldung.email,
    subject: `Ihre ${label} bei Clean Service Scaramuzzo AG`,
    html,
  });
}

/* --------------------------------------------------------------- Beekeeper */
const BK_URL = (process.env.BEEKEEPER_TENANT_URL || "").replace(/\/$/, "");
const BK_TOKEN = process.env.BEEKEEPER_API_TOKEN || "";

async function sendGroupMessage(chatId, body) {
  if (!BK_URL) throw new Error("BEEKEEPER_TENANT_URL ist nicht gesetzt.");
  if (!BK_TOKEN) throw new Error("BEEKEEPER_API_TOKEN ist nicht gesetzt.");

  // Pfad bestätigt durch Beekeeper-Support (Ticket #90097, 29.07.2026)
  const resp = await fetch(`${BK_URL}/api/2/chats/groups/${chatId}/messages`, {
    method: "POST",
    headers: { Authorization: `Token ${BK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!resp.ok) {
    throw new Error(`Beekeeper sendGroupMessage fehlgeschlagen: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

/* ------------------------------------------------------------------ Handler */
const ERLAUBTE_KATEGORIEN = ["verschiebung", "absage", "reklamation", "schaden", "zusatz"];
const SOFORT_BESTAETIGEN = ["absage"];

/* ---------------------------------------------------------------- Sitzung */
// Muss zu konto.js passen - sonst wird niemand erkannt.
const COOKIE = "kunde_session";

function sessionGeheim() {
  return process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_KEY || "cs-portal";
}

function sessionLesen(req) {
  const kopf = req.headers.cookie || "";
  const treffer = kopf.split(";").map(c => c.trim()).find(c => c.startsWith(COOKIE + "="));
  if (!treffer) return null;
  const [kontoId, ablauf, sig] = treffer.slice(COOKIE.length + 1).split(".");
  if (!kontoId || !ablauf || !sig) return null;
  const soll = crypto.createHmac("sha256", sessionGeheim())
                     .update(`${kontoId}.${ablauf}`).digest("hex").slice(0, 32);
  if (sig !== soll) return null;
  if (Date.now() > Number(ablauf)) return null;
  return kontoId;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { kategorie, details } = req.body || {};
  const ip = getClientIp(req);
  const supabase = getSupabase();

  if (!kategorie || !ERLAUBTE_KATEGORIEN.includes(kategorie)) {
    await logFehlversuch(supabase, { kategorie, grund: "ungueltige_kategorie", ip });
    res.status(400).json({ error: `Ungültige oder fehlende Kategorie. Erlaubt: ${ERLAUBTE_KATEGORIEN.join(", ")}` });
    return;
  }

  /* Identitaet kommt aus der Sitzung, nicht aus dem Formular.
     Wuerden wir Name und Objektnummer aus dem Body uebernehmen, koennte eine
     angemeldete Person die Felder manipulieren und in fremdem Namen melden.
     Die Anmeldung ersetzt zugleich das Captcha: Wer ein Passwort hat, ist kein Bot. */
  const kontoId = sessionLesen(req);
  if (!kontoId) {
    await logFehlversuch(supabase, { kategorie, grund: "nicht_angemeldet", ip });
    res.status(401).json({ error: "Bitte melden Sie sich an, um eine Meldung zu senden." });
    return;
  }

  const { data: konto } = await supabase
    .from("kundenzugaenge")
    .select("name, email, objekt_id, adresse, aktiv")
    .eq("id", kontoId)
    .maybeSingle();

  if (!konto || !konto.aktiv) {
    res.status(401).json({ error: "Bitte melden Sie sich an, um eine Meldung zu senden." });
    return;
  }

  const name = konto.name;
  const email = konto.email;
  const objekt_id = konto.objekt_id;
  const adresse = konto.adresse;

  const rate = await checkRateLimit(supabase, ip);
  if (!rate.allowed) {
    await logFehlversuch(supabase, { kategorie, grund: "rate_limit", ip });
    res.status(429).json({ error: "Zu viele Meldungen von dieser Verbindung in kurzer Zeit. Bitte später erneut versuchen oder direkt anrufen: 0844 355 355." });
    return;
  }

  // Zuordnung pruefen - aber niemals eine echte Kundenmeldung abweisen.
  // Unbekannt/leer => Meldung wird angenommen und im Admin-Bereich markiert.
  let zuordnung = null;
  if (objekt_id) {
    const { data, error: objektError } = await supabase
      .from("objekt_beekeeper_mapping")
      .select("objekt_id")
      .eq("objekt_id", objekt_id)
      .maybeSingle();
    if (objektError) console.error("Objektnummer-Pruefung fehlgeschlagen:", objektError.message);
    else zuordnung = data;
  }
  const zuordnungOffen = !zuordnung;

  const meldung = {
    kategorie, name,
    objekt_id: objekt_id || null,
    adresse: adresse || null,
    email,
    details: details || "",
    ip,
    status: "neu",
    zuordnung_offen: zuordnungOffen,
  };

  const { data: inserted, error: dbError } = await supabase
    .from("meldungen")
    .insert(meldung)
    .select()
    .single();

  if (dbError) {
    await logFehlversuch(supabase, { kategorie, grund: "db_fehler", ip });
    res.status(500).json({ error: `Speichern fehlgeschlagen: ${dbError.message}` });
    return;
  }

  const ergebnis = { id: inserted.id, team_mail: "pending", kunden_mail: "pending", beekeeper: "pending" };

  try {
    await sendeTeamMail(meldung);
    ergebnis.team_mail = "sent";
  } catch (err) {
    ergebnis.team_mail = "error";
    ergebnis.team_mail_detail = err.message;
  }

  if (SOFORT_BESTAETIGEN.includes(kategorie)) {
    try {
      await sendeKundenBestaetigung(meldung);
      ergebnis.kunden_mail = "sent";
    } catch (err) {
      ergebnis.kunden_mail = "error";
      ergebnis.kunden_mail_detail = err.message;
    }
  } else {
    ergebnis.kunden_mail = "wird_im_admin_bereich_beantwortet";
  }

  try {
    if (!objekt_id) throw new Error("keine Objektnummer angegeben");
    const { data: mapping } = await supabase
      .from("objekt_beekeeper_mapping")
      .select("beekeeper_chat_id, status")
      .eq("objekt_id", objekt_id)
      .single();

    if (mapping && mapping.status === "matched" && mapping.beekeeper_chat_id) {
      const label = {
        verschiebung: "🔄 Terminverschiebung",
        absage: "❌ Absage",
        reklamation: "⚠️ Reklamation",
        schaden: "🔧 Schadenmeldung",
        zusatz: "✨ Zusatzauftrag-Anfrage",
      }[kategorie];
      const text = `${label} — ${name} (Objekt ${objekt_id})${details ? `\n${details}` : ""}\n\nÜber das Kundenportal gemeldet.`;
      await sendGroupMessage(mapping.beekeeper_chat_id, text);
      ergebnis.beekeeper = "sent";
    } else {
      ergebnis.beekeeper = "no_mapping";
    }
  } catch (err) {
    ergebnis.beekeeper = "error";
    ergebnis.beekeeper_detail = err.message;
  }

  res.status(200).json(ergebnis);
};
