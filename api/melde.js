/**
 * POST /api/melde — nimmt eine Meldung aus dem Kundenportal entgegen.
 *
 * Ablauf:
 *   0. Anmeldung prüfen (die Sitzung ersetzt das Captcha)
 *   1. Angaben nach den Geschäftsregeln prüfen (siehe _regeln.js)
 *   2. Strukturiert in Supabase speichern - Aduna-tauglich: echte Datumsfelder,
 *      Objektnummer, aduna_status "ausstehend" für den späteren Abgleich
 *   3. Interne E-Mail (PFS bzw. Spezialreinigung)
 *   4. Bestätigung an die Kundschaft - bei JEDER Kategorie, damit niemand
 *      nachfragen muss, ob die Meldung angekommen ist
 *   5. Beekeeper-Nachricht an die feste Raumpflegerin (nur Absage/Verschiebung)
 */

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");
const R = require("./_regeln.js");
const BK = require("./_beekeeper.js");

const ABSENDER = process.env.MAIL_FROM || "Clean Service Scaramuzzo AG <noreply@clean-service.ch>";
const ABSENDER_INTERN = process.env.MAIL_FROM_INTERN || "Kundenportal <noreply@clean-service.ch>";
const MAIL_PFS = process.env.MAIL_PFS || "putzfrauenservice@clean-service.ch";
const MAIL_SPEZIAL = process.env.MAIL_SPEZIALREINIGUNG || "spezialreinigung@clean-service.ch";
const ABTEILUNGSLEITER = process.env.ABTEILUNGSLEITER || "Cristian Gambale";

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

/* -------------------------------------------------------------- Rate-Limit
   Pro Kundenkonto, nicht pro IP: Mehrere Haushalte können sich eine
   Verbindung teilen (Überbauung, Residenz), ein Konto dagegen nicht. */
const RATE_LIMIT = 10;          // max. Meldungen ...
const RATE_WINDOW_MINUTES = 60; // ... pro Stunde und Konto

async function checkRateLimit(supabase, email) {
  if (!email) return { allowed: true };
  const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("meldungen")
    .select("id", { count: "exact", head: true })
    .ilike("email", email)
    .gte("created_at", since);
  if (error) return { allowed: true }; // im Zweifel nie eine echte Meldung blockieren
  return { allowed: (count || 0) < RATE_LIMIT, count: count || 0 };
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

async function logFehlversuch(supabase, { kategorie, grund, ip }) {
  try {
    await supabase.from("fehlversuche").insert({ kategorie: kategorie || null, grund, ip });
  } catch {
    // Monitoring darf die eigentliche Anfrage nie zum Absturz bringen.
  }
}

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

/* ------------------------------------------------------------------ Texte */
const KATEGORIE_LABEL = {
  verschiebung: "Terminverschiebung",
  absage: "Absage",
  reklamation: "Reklamation",
  schaden: "Schadenmeldung",
  zusatz: "Anfrage für Zusatzarbeiten",
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const VERRECHNUNG_KUNDE = {
  "50": "Da die Absage weniger als 24 Stunden vor dem Einsatz erfolgt, wird der Einsatz gemäss unseren AGB zu 50 % verrechnet.",
  "100": "Da die Absage weniger als 4 Stunden vor dem Einsatz erfolgt, wird der Einsatz gemäss unseren AGB vollständig verrechnet.",
  pruefen: "Da die Absage kurzfristig erfolgt, prüfen wir anhand der geplanten Einsatzzeit, ob gemäss unseren AGB eine Verrechnung anfällt (weniger als 24 Stunden vorher: 50 %, weniger als 4 Stunden vorher: 100 %).",
};

const VERRECHNUNG_INTERN = {
  kostenlos: "Fristgerecht – kostenlos.",
  "50": "Kurzfristig (unter 24 Std.) – gemäss AGB 50 % verrechnen.",
  "100": "Sehr kurzfristig (unter 4 Std.) – gemäss AGB 100 % verrechnen.",
  pruefen: "Kurzfristig – Verrechnung hängt von der Einsatzzeit ab (unter 24 Std.: 50 %, unter 4 Std.: 100 %). Bitte prüfen.",
};

/** Der eine Satz, der der Kundschaft sagt, was jetzt passiert. */
function naechsterSchritt(kategorie, d, m) {
  if (kategorie === "verschiebung") {
    return `Die Reinigung vom ${R.datumCH(d.termin_datum)} entfällt. Ihr Ersatztermin am ${R.datumCH(d.termin_neu)} wird durch unser Springerteam ausgeführt. Die Reinigung findet zwischen 08.00 und 17.00 Uhr statt, die genaue Uhrzeit teilen wir Ihnen am Vortag mit.`;
  }
  if (kategorie === "absage") {
    const basis = d.zeitraum_bis
      ? `Die Reinigungen vom ${R.datumCH(d.termin_datum)} bis ${R.datumCH(d.zeitraum_bis)} sind abgesagt und entfallen ersatzlos. Danach läuft Ihre Reinigung wie gewohnt weiter.`
      : `Die Reinigung vom ${R.datumCH(d.termin_datum)} ist abgesagt und entfällt ersatzlos.`;
    return VERRECHNUNG_KUNDE[m.verrechnung] ? `${basis} ${VERRECHNUNG_KUNDE[m.verrechnung]}` : basis;
  }
  if (kategorie === "reklamation") {
    return d.reklamation_wunsch === "nachreinigung"
      ? "Es tut uns leid, dass die Reinigung nicht Ihren Erwartungen entsprochen hat. Unser Springerteam führt eine kostenlose Nachreinigung durch, den Termin teilen wir Ihnen mit."
      : `Es tut uns leid, dass die Reinigung nicht Ihren Erwartungen entsprochen hat. Unser Abteilungsleiter ${ABTEILUNGSLEITER} meldet sich innert 2 Arbeitstagen persönlich bei Ihnen.`;
  }
  if (kategorie === "schaden") {
    return "Ihre Schadenmeldung ist bei uns eingegangen. Wir melden uns innert 2 Arbeitstagen mit einer ersten Einschätzung.";
  }
  if (kategorie === "zusatz") {
    return "Unsere Spezialreinigung bereitet Ihre Offerte vor und meldet sich bei Ihnen. Wir versuchen, Ihren Wunschtermin zu halten.";
  }
  return "";
}

/* ------------------------------------------------------------------ E-Mail */
function resendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY ist nicht gesetzt.");
  return new Resend(apiKey);
}

async function sendeTeamMail(meldung, d, pdf) {
  const label = KATEGORIE_LABEL[meldung.kategorie];
  const ziel = meldung.kategorie === "zusatz" ? MAIL_SPEZIAL : MAIL_PFS;

  // Der Kasten oben sagt, was zu tun ist - oder dass nichts zu tun ist.
  let auftrag = "";
  if (meldung.kategorie === "absage" || meldung.kategorie === "verschiebung") {
    auftrag = `<p style="color:#1c7a5a;"><strong>Automatisch bestätigt.</strong> ${
      meldung.kategorie === "absage" ? esc(VERRECHNUNG_INTERN[meldung.verrechnung] || "") : "Ersatztermin durch das Springerteam einplanen."
    }</p>`;
  }
  if (meldung.kategorie === "reklamation") {
    auftrag = d.reklamation_wunsch === "nachreinigung"
      ? `<p style="color:#b3541e;"><strong>Nachreinigung durch das Springerteam einplanen.</strong> Intern: Die Nachreinigungszeit wird der fixen Raumpflegerin abgezogen.</p>`
      : `<p style="color:#b3541e;"><strong>Gespräch mit dem Abteilungsleiter gewünscht.</strong> Rückruf durch ${esc(ABTEILUNGSLEITER)} innert 2 Arbeitstagen.</p>`;
  }
  if (meldung.kategorie === "zusatz") {
    auftrag = `<p style="color:#12797A;"><strong>Bitte Offerte vorbereiten.</strong> Die Kundschaft hat eine Bestätigung erhalten, dass die Offerte folgt.</p>`;
  }

  const html = `
    <div style="font-family:Verdana,Geneva,sans-serif; color:#333; font-size:14px;">
    <h2 style="color:#12797A;">${esc(label)} über das Kundenportal</h2>
    ${auftrag}
    <p><strong>Name:</strong> ${esc(meldung.name) || "-"}<br>
       <strong>Objekt-/Kundennummer:</strong> ${esc(meldung.objekt_id) || "— nicht angegeben"}<br>
       <strong>Adresse:</strong> ${esc(meldung.adresse) || "-"}<br>
       <strong>E-Mail:</strong> ${esc(meldung.email) || "-"}</p>
    <pre style="white-space:pre-wrap; font-family:inherit; background:#F2F9F9; padding:12px 14px;">${esc(meldung.details)}</pre>
    ${pdf ? '<p style="color:#12797A;">Das vollständige Dokument mit Fotos liegt als PDF im Anhang.</p>' : ""}
    ${meldung._bk_hinweis ? `<p style="color:#b3541e;"><strong>Achtung: Die Raumpflegerin wurde NICHT über Beekeeper informiert</strong> (${esc(meldung._bk_hinweis)}). Bitte Bot in den Kundenchat aufnehmen bzw. im Admin unter „Beekeeper“ zuordnen und die Raumpflegerin direkt informieren.</p>` : ""}
    </div>`;

  const mail = {
    from: ABSENDER_INTERN,
    replyTo: meldung.email || ziel,
    to: ziel,
    subject: meldung.kategorie === "zusatz"
      ? `[Kundenportal] Offerte vorbereiten: ${R.ZUSATZ_ART[d.art]} – ${meldung.name}`
      : `[Kundenportal] ${label} – ${meldung.name || meldung.objekt_id || "Kunde"}`,
    html,
  };

  if (pdf) {
    const datum = R.datumZuerich(0);
    const kurz = String(meldung.name || "Kunde").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 30);
    mail.attachments = [{
      filename: `${label}_${meldung.objekt_id || "ohne-Nr"}_${kurz}_${datum}.pdf`,
      content: pdf.toString("base64"),
    }];
  }
  return resendClient().emails.send(mail);
}

async function sendeKundenBestaetigung(meldung, text) {
  if (!meldung.email) return { skipped: true };
  const label = KATEGORIE_LABEL[meldung.kategorie];
  const portal = (process.env.PORTAL_URL || "https://portal.clean-service.ch").replace(/\/$/, "");
  const html = `
    <div style="font-family:Verdana,Geneva,sans-serif; color:#333; max-width:560px; font-size:14px; line-height:1.7;">
      <p>Guten Tag ${esc(meldung.name)}</p>
      <p>Vielen Dank, Ihre ${esc(label)} ist bei uns eingegangen.</p>
      <p>${esc(text)}</p>
      <p style="margin:24px 0;">
        <a href="${portal}" style="background:#2BB6B7; color:#fff; text-decoration:none;
           padding:13px 24px; border-radius:8px; font-weight:bold; display:inline-block;">Im Kundenportal ansehen</a>
      </p>
      <p style="color:#767676; font-size:12px;">Sie müssen auf diese Nachricht nicht antworten.
        Den Stand Ihrer Meldungen sehen Sie jederzeit im Kundenportal.</p>
      <p style="color:#767676; font-size:12px; margin-top:20px;">
        Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · 0844 355 355</p>
    </div>`;
  return resendClient().emails.send({
    from: ABSENDER,
    to: meldung.email,
    subject: `Bestätigung: Ihre ${label} bei Clean Service Scaramuzzo AG`,
    html,
  });
}

/* --------------------------------------------------------------- Beekeeper */
// Nur was die feste Raumpflegerin für ihre Planung wissen muss. Reklamationen
// gehen bewusst nicht in den Chat - die klärt zuerst das Büro.
const BEEKEEPER_KATEGORIEN = ["absage", "verschiebung"];

function beekeeperText(kategorie, m, d) {
  const kunde = `${m.name}${m.objekt_id ? ` (Objekt ${m.objekt_id})` : ""}`;

  /* Verschiebung: Für die feste Raumpflegerin ist das eine Terminabsage -
     der Ersatztermin läuft über das Springerteam, nicht über sie. */
  if (kategorie === "verschiebung") {
    const z = [
      `❌ Terminabsage — ${kunde}`, "",
      `Die Reinigung vom ${R.datumCH(d.termin_datum)} findet für dich NICHT statt.`,
      "Die Kundschaft hat den Termin verschoben, den Ersatztermin übernimmt das Springerteam.", "",
      "Alle weiteren Termine bleiben für dich wie gewohnt.",
    ];
    if (d.kommentar) z.push("", `Bemerkung der Kundschaft: ${d.kommentar}`);
    z.push("", "Gemeldet über das Kundenportal.");
    return z.join("\n");
  }

  const z = [`❌ Reinigungsabsage — ${kunde}`, ""];
  if (d.zeitraum_bis) {
    z.push(`Vom ${R.datumCH(d.termin_datum)} bis und mit ${R.datumCH(d.zeitraum_bis)} entfallen ALLE Reinigungen (Abwesenheit der Kundschaft).`,
           "Danach geht es wie gewohnt weiter.");
  } else {
    z.push(`Die Reinigung vom ${R.datumCH(d.termin_datum)} entfällt ersatzlos.`,
           "Alle weiteren Termine bleiben wie gewohnt.");
  }
  if (d.kommentar) z.push("", `Bemerkung der Kundschaft: ${d.kommentar}`);
  z.push("", "Gemeldet über das Kundenportal.");
  return z.join("\n");
}

/* ------------------------------------------------------------------ Handler */
const ERLAUBTE_KATEGORIEN = Object.keys(KATEGORIE_LABEL);

/* Status beim Eingang:
   absage/verschiebung  -> laufen vollautomatisch, direkt "angenommen"
   zusatz               -> liegt bei der Spezialreinigung, im PFS-Posteingang
                           nicht sichtbar ("in Abklärung" = Offerte in Arbeit)
   reklamation/schaden  -> brauchen einen Menschen, landen im Posteingang */
const START_STATUS = {
  absage: "akzeptieren", verschiebung: "akzeptieren",
  zusatz: "abklaerung", reklamation: "neu", schaden: "neu",
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const body = req.body || {};
  const kategorie = body.kategorie;
  const ip = getClientIp(req);
  const supabase = getSupabase();

  if (!ERLAUBTE_KATEGORIEN.includes(kategorie)) {
    await logFehlversuch(supabase, { kategorie, grund: "ungueltige_kategorie", ip });
    res.status(400).json({ error: "Ungültige oder fehlende Kategorie." });
    return;
  }

  /* Identität kommt aus der Sitzung, nie aus dem Formular - sonst könnte eine
     angemeldete Person in fremdem Namen melden. */
  const kontoId = sessionLesen(req);
  if (!kontoId) {
    await logFehlversuch(supabase, { kategorie, grund: "nicht_angemeldet", ip });
    res.status(401).json({ error: "Bitte melden Sie sich an, um eine Meldung zu senden." });
    return;
  }
  const { data: konto } = await supabase
    .from("kundenzugaenge").select("name, email, objekt_id, adresse, aktiv")
    .eq("id", kontoId).maybeSingle();
  if (!konto || !konto.aktiv) {
    res.status(401).json({ error: "Bitte melden Sie sich an, um eine Meldung zu senden." });
    return;
  }

  const pruefung = R.pruefeMeldung(kategorie, body);
  if (pruefung.fehler) {
    await logFehlversuch(supabase, { kategorie, grund: "regel_verletzt", ip });
    res.status(400).json({ error: pruefung.fehler });
    return;
  }
  const d = pruefung.daten;

  const rate = await checkRateLimit(supabase, konto.email);
  if (!rate.allowed) {
    await logFehlversuch(supabase, { kategorie, grund: "rate_limit", ip });
    res.status(429).json({ error: "Zu viele Meldungen in kurzer Zeit. Bitte später erneut versuchen oder anrufen: 0844 355 355." });
    return;
  }

  /* Kundenchat finden - bei Bedarf automatisch über den Chatnamen
     ("… PFS <Kundennummer>") zuordnen. Eine Beekeeper-Störung darf die
     Meldung nie blockieren. */
  let chat;
  try { chat = await BK.chatFuerObjekt(supabase, konto.objekt_id); }
  catch (err) { chat = { fehlt: err.message }; }

  const meldung = {
    kategorie,
    name: konto.name,
    objekt_id: konto.objekt_id || null,
    adresse: konto.adresse || null,
    email: konto.email,
    details: R.detailsText(kategorie, d),
    ip,
    status: START_STATUS[kategorie],
    zuordnung_offen: !chat.chatId,
    termin_datum: d.termin_datum || null,
    termin_neu: d.termin_neu || null,
    zeitraum_bis: d.zeitraum_bis || null,
    reinigungsdatum: d.reinigungsdatum || null,
    reklamation_wunsch: d.reklamation_wunsch || null,
    // Aduna: alles ausser Zusatzarbeiten (die laufen über die Spezialreinigung)
    aduna_status: kategorie === "zusatz" ? "nicht_relevant" : "ausstehend",
  };

  if (kategorie === "absage") {
    Object.assign(meldung, R.verrechnungAbsage(d.termin_datum));
  }
  if (kategorie === "verschiebung") {
    meldung.vorlauf_stunden = R.verrechnungAbsage(d.termin_datum).vorlauf_stunden;
  }

  const text = naechsterSchritt(kategorie, d, meldung);
  if (kategorie === "zusatz" || kategorie === "absage" || kategorie === "verschiebung") {
    meldung.admin_note = text;   // erscheint im Kundenkonto als Rückmeldung
  }

  const { data: inserted, error: dbError } = await supabase
    .from("meldungen").insert(meldung).select().single();
  if (dbError) {
    await logFehlversuch(supabase, { kategorie, grund: "db_fehler", ip });
    res.status(500).json({ error: "Ihre Meldung konnte nicht gespeichert werden. Bitte erneut versuchen oder anrufen: 0844 355 355." });
    console.error("melde.js DB:", dbError.message);
    return;
  }

  const ergebnis = { id: inserted.id, naechster_schritt: text };

  // Interne Notiz zur Reklamation - hält fest, was das Team zu tun hat
  if (kategorie === "reklamation") {
    await supabase.from("meldung_notizen").insert({
      meldung_id: inserted.id, autor: "System",
      text: d.reklamation_wunsch === "nachreinigung"
        ? "Kunde wünscht Nachreinigung durch das Springerteam. Die Nachreinigungszeit wird der fixen Raumpflegerin abgezogen."
        : `Kunde wünscht ein Gespräch mit dem Abteilungsleiter – Rückruf durch ${ABTEILUNGSLEITER}.`,
    }).then(() => {}, () => {});
  }

  // PDF mit Fotos für Reklamation und Schaden. Fotos werden nirgends gespeichert.
  let pdf = null;
  if (kategorie === "reklamation" || kategorie === "schaden") {
    try {
      const { meldungPdf } = require("./_meldung-pdf.js");
      pdf = meldungPdf({
        kategorie, name: meldung.name, objekt_id: meldung.objekt_id,
        adresse: meldung.adresse, email: meldung.email,
        reinigungsdatum: R.datumCH(d.reinigungsdatum),
        wunsch: d.reklamation_wunsch ? R.WUNSCH_LABEL[d.reklamation_wunsch] : null,
        beschreibung: d.beschreibung,
        fotos: Array.isArray(body.fotos) ? body.fotos.slice(0, 8) : [],
      });
      ergebnis.pdf = "ok";
    } catch (err) {
      console.error("melde.js: PDF fehlgeschlagen", err);
      ergebnis.pdf = "error";
    }
  }

  let bkStatus = null;
  if (BEEKEEPER_KATEGORIEN.includes(kategorie)) {
    if (chat.chatId) {
      try { await BK.senden(chat.chatId, beekeeperText(kategorie, meldung, d)); bkStatus = "sent"; }
      catch (err) { bkStatus = "error"; chat.fehlt = err.message; console.error("Beekeeper:", err.message); }
    } else {
      bkStatus = "no_mapping";
    }
  }
  ergebnis.beekeeper = bkStatus || undefined;
  // Die Teammail sagt, wenn die Raumpflegerin NICHT informiert wurde
  meldung._bk_hinweis = (bkStatus === "no_mapping" || bkStatus === "error") ? chat.fehlt : null;

  const [team, kunde] = await Promise.allSettled([
    sendeTeamMail(meldung, d, pdf),
    sendeKundenBestaetigung(meldung, text),
  ]);
  ergebnis.team_mail = team.status === "fulfilled" ? "sent" : "error";
  ergebnis.kunden_mail = kunde.status === "fulfilled" ? "sent" : "error";
  if (team.status === "rejected") console.error("Teammail:", team.reason && team.reason.message);
  if (kunde.status === "rejected") console.error("Kundenmail:", kunde.reason && kunde.reason.message);

  res.status(200).json(ergebnis);
};
