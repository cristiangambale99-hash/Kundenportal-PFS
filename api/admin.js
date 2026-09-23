/**
 * /api/admin — sammelt alle Admin-Funktionen in einer Datei.
 *
 * Aufruf über den Parameter "action":
 *   POST /api/admin?action=login      { password }
 *   GET  /api/admin?action=list       [&kategorie=..&status=..]
 *   GET  /api/admin?action=customers  (pro Kunde gruppiert, mit Ampel)
 *   GET  /api/admin?action=stats      (Kennzahlen der letzten 30 Tage)
 *   POST /api/admin?action=reply      { id, action: akzeptieren|ablehnen|erledigt|nachricht, nachricht }
 *   GET  /api/admin?action=namen      (Namensliste für die Anmeldung, ohne Sitzung)
 *   GET  /api/admin?action=ich        (angemeldeter Name)
 *   POST /api/admin?action=name       { name }  Namen für die laufende Sitzung wählen
 *   POST /api/admin?action=konten-import   { kunden: [{objekt_id, name, email, adresse}] }
 *   GET  /api/admin?action=welle-status
 *   POST /api/admin?action=zugang-welle    { anzahl }  Zugangsdaten per Mail versenden
 *
 * Wer etwas bearbeitet, steht in der Sitzung: Beim Anmelden wählt man seinen
 * Namen, danach wird er automatisch bei Notizen, Übernahmen und Antworten
 * eingetragen. Ein gemeinsames Passwort, aber nachvollziehbar pro Person.
 *
 * Bewusst in einer Datei zusammengefasst, damit das Projekt ohne verschachtelte
 * Ordner auskommt und sich leicht hochladen lässt.
 */

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

/* Absenderadresse. Bewusst "noreply": Antworten auf diese Mails wuerden im
   Postfach landen und muessten von Hand bearbeitet werden - genau das soll das
   Portal ersetzen. Ueber MAIL_FROM laesst sich die Adresse ohne Codeaenderung
   anpassen. */
const ABSENDER = process.env.MAIL_FROM || "Clean Service Scaramuzzo AG <noreply@clean-service.ch>";


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

/* Wer sich anmelden kann. Über ADMIN_NAMEN (kommagetrennt) ohne Codeänderung
   anpassbar, z.B. wenn jemand Neues ins Team kommt. */
function adminNamen() {
  const env = (process.env.ADMIN_NAMEN || "").split(",").map(n => n.trim()).filter(Boolean);
  return env.length ? env : ["Cristian Gambale", "Fiorella Scalone", "Tayron Moreno", "Lina"];
}

function sign(value) {
  return crypto.createHmac("sha256", process.env.ADMIN_PASSWORD || "").update(value).digest("hex");
}

// Format: <ablauf>.<name base64url>.<signatur>  - Name leer = noch nicht gewählt
function createSessionCookie(name) {
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const n = Buffer.from(name || "", "utf8").toString("base64url");
  const value = `${expires}.${n}.${sign(`${expires}.${n}`)}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
}

/** null = keine gültige Sitzung, sonst { name } (name kann leer sein). */
function readSession(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.split(";").map(c => c.trim()).find(c => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const teile = match.slice(COOKIE_NAME.length + 1).split(".");
  if (teile.length !== 3) return null;
  const [expires, n, signature] = teile;
  const a = Buffer.from(sign(`${expires}.${n}`));
  const b = Buffer.from(signature || "");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expires)) return null;
  return { name: Buffer.from(n, "base64url").toString("utf8") };
}

/* ------------------------------------------------------------------ E-Mail */
const KATEGORIE_LABEL = {
  verschiebung: "Terminverschiebung",
  absage: "Absage",
  reklamation: "Reklamation",
  schaden: "Schadenmeldung",
  zusatz: "Zusatzauftrag-Anfrage",
};

async function sendeAdminAntwort({ email, name, betreff, nachricht, status, kategorie }) {
  if (!email) throw new Error("Keine E-Mail-Adresse für diese Meldung hinterlegt.");
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY ist nicht gesetzt.");

  const portal = (process.env.PORTAL_URL || "https://portal.clean-service.ch").replace(/\/$/, "");
  const statusText = { akzeptieren: "Angenommen", ablehnen: "Abgelehnt",
                       erledigt: "Erledigt", neu: "In Bearbeitung" }[status] || "";

  // Der Statusstreifen macht auf einen Blick klar, worum es geht - und der
  // Knopf holt die Kundschaft ins Portal zurueck, statt eine Mailantwort
  // auszuloesen, die wieder von Hand bearbeitet werden muesste.
  const html = `
    <div style="font-family:Verdana,Geneva,sans-serif; color:#333; max-width:560px;">
      <p>Guten Tag ${name || ""}</p>
      <p>Es gibt eine Rückmeldung zu Ihrer ${kategorie || "Meldung"}.</p>

      ${statusText ? `
      <div style="margin:20px 0; padding:14px 18px; background:#F2F9F9; border-left:3px solid #2BB6B7;">
        <div style="font-size:11px; letter-spacing:.5px; color:#767676; text-transform:uppercase; margin-bottom:4px;">Neuer Stand</div>
        <div style="font-size:16px; font-weight:bold; color:#12797A;">${statusText}</div>
      </div>` : ""}

      <p style="white-space:pre-wrap; line-height:1.7;">${nachricht}</p>

      <p style="margin:26px 0;">
        <a href="${portal}" style="background:#2BB6B7; color:#ffffff; text-decoration:none;
           padding:14px 26px; border-radius:8px; font-weight:bold; display:inline-block;">
          Im Kundenportal ansehen
        </a>
      </p>

      <p style="color:#767676; font-size:12px; line-height:1.6;">
        Im Portal sehen Sie jederzeit alle Ihre Meldungen und deren Stand.
        Sie müssen auf diese Nachricht nicht antworten.
      </p>
      <p style="color:#767676; font-size:12px; margin-top:20px;">
        Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · 0844 355 355
      </p>
    </div>
  `;
  return new Resend(apiKey).emails.send({
    from: ABSENDER,
    to: email,
    subject: betreff || "Rückmeldung zu Ihrer Meldung",
    html,
  });
}


/* ------------------------------------------------------- Kundenkonten */
// Erstpasswort fuer Bestandskunden ohne neuen Vertrag. Gut lesbar, ohne
// verwechselbare Zeichen (kein O/0, kein I/1) - es wird am Telefon durchgegeben
// oder abgetippt.
const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function erstpasswortErzeugen() {
  const teil = n => Array.from({ length: n }, () =>
    PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)]).join("");
  return `${teil(4)}-${teil(4)}`;
}

// Muss zu konto.js passen - sonst laesst sich das Passwort nicht pruefen.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashen(passwort, salt) {
  return crypto.scryptSync(String(passwort), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString("hex");
}

/* ------------------------------------------------------------------- Ampel */
/**
 * ROT   - mind. 3 Reklamationen/Schäden in 90 Tagen ODER eine Absage in 30 Tagen
 * GELB  - 1-2 Reklamationen/Schäden in 90 Tagen ODER 2+ Verschiebungen in 90 Tagen
 * GRÜN  - alles andere
 */
/**
 * Ampel für die Kundenübersicht.
 *
 * Eine reine Zählregel über die Meldungen im Portal — keine Vorhersage.
 * Sie liefert die Farbe UND den Grund, damit im Tool nachvollziehbar ist,
 * welche Regel ausgelöst hat. Ohne Begründung ist eine Ampel nicht
 * überprüfbar, und was man nicht überprüfen kann, glaubt man irgendwann
 * nicht mehr.
 *
 * Die Schwellen stehen bewusst an einer Stelle und sind hier dokumentiert.
 */
const AMPEL_REGELN = {
  rot: [
    { schluessel: "rs90_3",      text: "3 oder mehr Reklamationen/Schäden in 90 Tagen" },
    { schluessel: "absagen30_1", text: "mindestens 1 Einzelabsage in 30 Tagen (Ferien zählen nicht)" },
  ],
  gelb: [
    { schluessel: "rs90_1",   text: "1 Reklamation oder Schaden in 90 Tagen" },
    { schluessel: "versch90_2", text: "2 Verschiebungen in 90 Tagen" },
  ],
};

function berechneAmpel(meldungen) {
  const jetzt = Date.now();
  const tage = (m) => (jetzt - new Date(m.created_at).getTime()) / 86400000;

  const rs90 = meldungen.filter(m => (m.kategorie === "reklamation" || m.kategorie === "schaden") && tage(m) <= 90).length;
  // Ferien-Abwesenheiten (Absage mit Zeitraum) sind kein Warnsignal
  const absagen30 = meldungen.filter(m => m.kategorie === "absage" && !m.zeitraum_bis && tage(m) <= 30).length;
  const versch90 = meldungen.filter(m => m.kategorie === "verschiebung" && tage(m) <= 90).length;

  const zahlen = { rs90, absagen30, versch90 };

  if (rs90 >= 3) return { farbe: "rot", grund: `${rs90} Reklamationen/Schäden in den letzten 90 Tagen`, zahlen };
  if (absagen30 >= 1) return { farbe: "rot", grund: `${absagen30} ${absagen30 === 1 ? "Absage" : "Absagen"} in den letzten 30 Tagen`, zahlen };
  if (rs90 >= 1) return { farbe: "gelb", grund: `${rs90} ${rs90 === 1 ? "Reklamation/Schaden" : "Reklamationen/Schäden"} in den letzten 90 Tagen`, zahlen };
  if (versch90 >= 2) return { farbe: "gelb", grund: `${versch90} Verschiebungen in den letzten 90 Tagen`, zahlen };
  return { farbe: "gruen", grund: "Keine Auffälligkeiten in den Zeitfenstern", zahlen };
}

const STANDARD_TEXTE = {
  abklaerung: "Ihre Meldung ist bei uns eingegangen. Wir klären den Sachverhalt ab und melden uns, sobald wir mehr wissen.",
  akzeptieren: "Ihr Wunschtermin wurde bestätigt.",
  ablehnen: "Leider können wir Ihren Wunschtermin nicht wie gewünscht anbieten. Wir melden uns mit einem Alternativvorschlag.",
  erledigt: "Ihre Meldung wurde bearbeitet und ist damit abgeschlossen.",
};

/* ----------------------------------------------------------------- Handler */
module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || "";

  /* --- Namensliste für die Anmeldemaske (ohne Sitzung) --- */
  if (action === "namen") {
    res.status(200).json({ namen: adminNamen() });
    return;
  }

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
    const name = String((req.body || {}).name || "").trim();
    if (!adminNamen().includes(name)) {
      res.status(400).json({ error: "Bitte wählen Sie Ihren Namen aus." });
      return;
    }
    res.setHeader("Set-Cookie", createSessionCookie(name));
    res.status(200).json({ ok: true, name });
    return;
  }

  /* --- Ab hier ist eine gültige Sitzung Pflicht --- */
  const sitzung = readSession(req);
  if (!sitzung) { res.status(401).json({ error: "Nicht angemeldet." }); return; }

  /* --- Wer ist angemeldet --- */
  if (action === "ich") {
    res.status(200).json({ name: sitzung.name || null, namen: adminNamen() });
    return;
  }

  /* --- Namen wählen/wechseln (z.B. nach Anmeldung über die Kundenmaske) --- */
  if (action === "name") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const name = String((req.body || {}).name || "").trim();
    if (!adminNamen().includes(name)) { res.status(400).json({ error: "Unbekannter Name." }); return; }
    res.setHeader("Set-Cookie", createSessionCookie(name));
    res.status(200).json({ ok: true, name });
    return;
  }

  // Alles Folgende braucht einen Namen - sonst wäre nicht nachvollziehbar, wer was tat.
  if (!sitzung.name) { res.status(403).json({ error: "Bitte zuerst Ihren Namen wählen.", name_fehlt: true }); return; }
  const ICH = sitzung.name;

  const supabase = getSupabase();

  /* --- Liste aller Meldungen --- */
  if (action === "list") {
    let query = supabase.from("meldungen").select("*").order("created_at", { ascending: false }).limit(200);
    if (req.query.kategorie) query = query.eq("kategorie", req.query.kategorie);
    if (req.query.status) query = query.eq("status", req.query.status);
    const { data, error } = await query;
    if (error) { res.status(500).json({ error: error.message }); return; }

    /* Notizen gleich mitliefern: ein zweiter Aufruf pro Meldung würde bei
       200 Einträgen 200 Anfragen bedeuten. */
    const ids = (data || []).map(m => m.id);
    let notizen = [];
    if (ids.length) {
      const { data: n } = await supabase
        .from("meldung_notizen")
        .select("id, meldung_id, autor, text, created_at")
        .in("meldung_id", ids)
        .order("created_at", { ascending: false });
      notizen = n || [];
    }
    const proMeldung = {};
    notizen.forEach(n => {
      (proMeldung[n.meldung_id] = proMeldung[n.meldung_id] || []).push(n);
    });

    res.status(200).json({
      meldungen: (data || []).map(m => ({ ...m, notizen: proMeldung[m.id] || [] })),
    });
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
        ...(() => { const a = berechneAmpel(k.meldungen);
                    return { ampel: a.farbe, ampel_grund: a.grund, ampel_zahlen: a.zahlen }; })(),
        meldungen: k.meldungen,
      };
    });

    const rang = { rot: 0, gelb: 1, gruen: 2 };
    kunden.sort((a, b) =>
      rang[a.ampel] !== rang[b.ampel]
        ? rang[a.ampel] - rang[b.ampel]
        : new Date(b.letzte_meldung) - new Date(a.letzte_meldung));

    res.status(200).json({ kunden, regeln: AMPEL_REGELN });
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
    const bearbeiter = ICH;
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
          status: neuerStatus, kategorie: label,
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
      .update({
        status: neuerStatus,
        admin_note: text || meldung.admin_note,
        bearbeiter: bearbeiter || meldung.bearbeiter,
        aktualisiert_am: new Date().toISOString(),
      })
      .eq("id", id);
    if (updateError) { res.status(500).json({ error: updateError.message }); return; }

    res.status(200).json({ ok: true, mail: mailStatus, mail_error: mailError });
    return;
  }

  /* --- Interne Notiz ---
     Bleibt ausschliesslich im Adminbereich. Sie geht nie an die Kundschaft und
     landet nicht in admin_note - das ist das Feld, das im Portal sichtbar ist. */
  if (action === "notiz") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const { id, text } = req.body || {};
    const autor = ICH;
    if (!id || !text || !String(text).trim()) {
      res.status(400).json({ error: "id und text sind erforderlich." });
      return;
    }
    const { error } = await supabase.from("meldung_notizen").insert({
      meldung_id: id, autor: autor || null, text: String(text).trim(),
    });
    if (error) { res.status(500).json({ error: error.message }); return; }

    await supabase.from("meldungen")
      .update({ aktualisiert_am: new Date().toISOString() })
      .eq("id", id);

    res.status(200).json({ ok: true });
    return;
  }

  /* --- Notizen einer Meldung lesen --- */
  if (action === "notizen") {
    const id = (req.query || {}).id;
    if (!id) { res.status(400).json({ error: "id ist erforderlich." }); return; }
    const { data, error } = await supabase
      .from("meldung_notizen")
      .select("id, autor, text, created_at")
      .eq("meldung_id", id)
      .order("created_at", { ascending: false });
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ notizen: data || [] });
    return;
  }

  /* --- Status intern setzen, ohne Mail ---
     Fuer Zwischenstaende wie "in Abklaerung": das Team haelt fest, wo die
     Sache steht, ohne die Kundschaft mit einer Mail zu behelligen. Den
     Status sieht sie im Portal trotzdem. */
  if (action === "status") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const { id, status } = req.body || {};
    const bearbeiter = ICH;
    const erlaubt = ["neu", "abklaerung", "akzeptieren", "ablehnen", "erledigt"];
    if (!id || !erlaubt.includes(status)) {
      res.status(400).json({ error: "id und ein gültiger Status sind erforderlich." });
      return;
    }
    const felder = { status, aktualisiert_am: new Date().toISOString() };
    felder.bearbeiter = bearbeiter;

    /* "In Abklärung" ist der einzige Statuswechsel, der die Kundschaft
       benachrichtigt. Sie soll wissen, dass die Sache gesehen wurde und
       geprüft wird - genau das erspart den Nachfrage-Anruf. Die übrigen
       Wechsel bleiben still; für eine Entscheidung gibt es die Antwort mit
       eigenem Text. */
    let mailStatus = "skipped", mailError = null;
    if (status === "abklaerung") {
      const { data: meldung } = await supabase
        .from("meldungen").select("*").eq("id", id).single();

      if (meldung && meldung.email) {
        const label = KATEGORIE_LABEL[meldung.kategorie] || meldung.kategorie;
        const text = (req.body || {}).nachricht || STANDARD_TEXTE.abklaerung;
        try {
          await sendeAdminAntwort({
            email: meldung.email, name: meldung.name,
            betreff: `Ihre ${label} ist in Abklärung`, nachricht: text,
            status, kategorie: label,
          });
          mailStatus = "sent";
          felder.admin_note = text;
        } catch (err) {
          mailStatus = "error";
          mailError = err.message;
          // Der Statuswechsel gilt trotzdem - eine Mailstoerung darf die
          // Bearbeitung nicht blockieren.
        }
      }
    }

    const { error } = await supabase.from("meldungen").update(felder).eq("id", id);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ ok: true, mail: mailStatus, mail_error: mailError });
    return;
  }

  /* --- Bearbeitung uebernehmen --- */
  if (action === "uebernehmen") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const { id } = req.body || {};
    if (!id) { res.status(400).json({ error: "id ist erforderlich." }); return; }
    const { error } = await supabase.from("meldungen")
      .update({ bearbeiter: ICH, aktualisiert_am: new Date().toISOString() })
      .eq("id", id);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  /* --- Kundenkonto anlegen (Bestandskunden ohne neuen Vertrag) --- */
  if (action === "konto-anlegen") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const { objekt_id, name, email, adresse } = req.body || {};
    if (!objekt_id || !name || !email) {
      res.status(400).json({ error: "Objektnummer, Name und E-Mail sind erforderlich." });
      return;
    }
    const mail = String(email).trim().toLowerCase();

    // "verwaltung" ist die Anmelde-ID des Teams. Als Kundenkonto angelegt waere
    // es tot: die Anmeldung prueft das Verwaltungskonto zuerst.
    if (mail === "verwaltung") {
      res.status(400).json({ error: "Diese Anmelde-ID ist für die Verwaltung reserviert." });
      return;
    }

    const { data: vorhanden } = await supabase
      .from("kundenzugaenge").select("id, passwort_gesetzt").ilike("email", mail).maybeSingle();

    const pw = erstpasswortErzeugen();
    const salt = crypto.randomBytes(16).toString("hex");
    const felder = {
      objekt_id: String(objekt_id), name, adresse: adresse || null,
      passwort_salt: salt, passwort_hash: hashen(pw, salt),
      passwort_gesetzt: false, aktiv: true,
      fehlversuche: 0, gesperrt_bis: null,
    };

    if (vorhanden) {
      if (vorhanden.passwort_gesetzt) {
        res.status(400).json({
          error: "Zu dieser E-Mail besteht bereits ein Konto mit eigenem Passwort. Bitte stattdessen das Passwort zurücksetzen.",
        });
        return;
      }
      const { error } = await supabase.from("kundenzugaenge").update(felder).eq("id", vorhanden.id);
      if (error) { res.status(500).json({ error: error.message }); return; }
    } else {
      const { error } = await supabase.from("kundenzugaenge").insert({ ...felder, email: mail });
      if (error) { res.status(500).json({ error: error.message }); return; }
    }

    res.status(200).json({ ok: true, anmeldeId: mail, erstpasswort: pw });
    return;
  }

  /* --- Alle Kundenkonten auflisten --- */
  if (action === "zugaenge") {
    const { data, error } = await supabase
      .from("kundenzugaenge")
      .select("id, objekt_id, name, email, aktiv, passwort_gesetzt, letzter_login, erstellt_am")
      .order("erstellt_am", { ascending: false })
      .limit(600);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ zugaenge: data });
    return;
  }

  /* --- Passwort zuruecksetzen (fuer Anrufe) ---
     Erzeugt ein neues Erstpasswort, das am Telefon durchgegeben wird. Beim
     naechsten Anmelden muss die Kundschaft wieder ein eigenes Passwort setzen. */
  if (action === "passwort-zuruecksetzen") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const { id } = req.body || {};
    if (!id) { res.status(400).json({ error: "id ist erforderlich." }); return; }

    const pw = erstpasswortErzeugen();
    const salt = crypto.randomBytes(16).toString("hex");
    const { error } = await supabase.from("kundenzugaenge").update({
      passwort_salt: salt, passwort_hash: hashen(pw, salt),
      passwort_gesetzt: false, reset_hash: null, reset_ablauf: null,
      fehlversuche: 0, gesperrt_bis: null,
    }).eq("id", id);

    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ ok: true, erstpasswort: pw });
    return;
  }

  /* --- Konto deaktivieren (z.B. bei Kuendigung) --- */
  if (action === "konto-deaktivieren") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const { id } = req.body || {};
    if (!id) { res.status(400).json({ error: "id ist erforderlich." }); return; }
    const { error } = await supabase.from("kundenzugaenge").update({ aktiv: false }).eq("id", id);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  /* --- Bestandskunden importieren (ohne Passwort, ohne Mail) ---
     Legt nur die Konten an. Die Zugangsdaten gehen erst mit der Welle raus -
     so entsteht das Erstpasswort im Moment des Versands und steht nirgends
     im Klartext herum. Bestehende Konten werden nie überschrieben. */
  if (action === "konten-import") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const liste = Array.isArray((req.body || {}).kunden) ? req.body.kunden : [];
    if (!liste.length) { res.status(400).json({ error: "Keine Kunden übermittelt." }); return; }
    if (liste.length > 1000) { res.status(400).json({ error: "Höchstens 1000 Kunden pro Import." }); return; }

    const gueltig = [], fehler = [];
    const gesehen = new Set();
    liste.forEach((k, i) => {
      const email = String(k.email || "").trim().toLowerCase();
      const objekt = String(k.objekt_id || "").trim();
      const name = String(k.name || "").trim();
      if (!objekt || !name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        fehler.push({ zeile: i + 1, name, grund: "Objektnummer, Name oder gültige E-Mail fehlt" });
        return;
      }
      if (gesehen.has(email)) { fehler.push({ zeile: i + 1, name, grund: `E-Mail ${email} doppelt in der Liste` }); return; }
      gesehen.add(email);
      gueltig.push({ objekt_id: objekt, name, email, adresse: String(k.adresse || "").trim() || null });
    });

    const { data: vorhanden } = await supabase.from("kundenzugaenge").select("email");
    const bekannt = new Set((vorhanden || []).map(v => String(v.email).toLowerCase()));
    const neu = gueltig.filter(k => !bekannt.has(k.email));
    const uebersprungen = gueltig.length - neu.length;

    if (neu.length) {
      const { error } = await supabase.from("kundenzugaenge").insert(
        neu.map(k => ({ ...k, passwort_gesetzt: false, aktiv: true, fehlversuche: 0 })));
      if (error) { res.status(500).json({ error: error.message }); return; }
    }
    res.status(200).json({ ok: true, angelegt: neu.length, bereits_vorhanden: uebersprungen, fehler });
    return;
  }

  /* --- Stand des Rollouts --- */
  if (action === "welle-status") {
    const { data, error } = await supabase.from("kundenzugaenge")
      .select("aktiv, passwort_gesetzt, info_gesendet_am");
    if (error) { res.status(500).json({ error: error.message }); return; }
    const aktiv = (data || []).filter(k => k.aktiv);
    res.status(200).json({
      total: aktiv.length,
      gesendet: aktiv.filter(k => k.info_gesendet_am).length,
      offen: aktiv.filter(k => !k.info_gesendet_am && !k.passwort_gesetzt).length,
      aktiviert: aktiv.filter(k => k.passwort_gesetzt).length,
      portal_url: process.env.PORTAL_URL || null,
    });
    return;
  }

  /* --- Zugangsdaten in Wellen versenden ---
     Pro Aufruf höchstens 100 Konten, damit der Support nach dem Versand
     nicht überrollt wird und die Funktion im Zeitlimit bleibt. */
  if (action === "zugang-welle") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const portal = (process.env.PORTAL_URL || "").replace(/\/$/, "");
    if (!portal) {
      res.status(400).json({ error: "PORTAL_URL ist bei Vercel nicht gesetzt. Ohne sie würden die Links in den Mails ins Leere führen." });
      return;
    }
    if (!process.env.RESEND_API_KEY) { res.status(500).json({ error: "RESEND_API_KEY ist nicht gesetzt." }); return; }
    const anzahl = Math.max(1, Math.min(100, Number((req.body || {}).anzahl) || 50));

    const { data: konten, error } = await supabase.from("kundenzugaenge")
      .select("id, name, email")
      .eq("aktiv", true).eq("passwort_gesetzt", false).is("info_gesendet_am", null)
      .order("erstellt_am", { ascending: true })
      .limit(anzahl);
    if (error) { res.status(500).json({ error: error.message }); return; }
    if (!konten.length) { res.status(200).json({ ok: true, gesendet: 0, hinweis: "Alle Kunden haben ihre Zugangsdaten bereits erhalten." }); return; }

    const mails = [], updates = [];
    for (const k of konten) {
      const pw = erstpasswortErzeugen();
      const salt = crypto.randomBytes(16).toString("hex");
      updates.push({ id: k.id, passwort_salt: salt, passwort_hash: hashen(pw, salt) });
      mails.push({
        from: ABSENDER, to: k.email,
        subject: "Ihr persönlicher Zugang zum Clean Service Kundenportal",
        html: willkommensMail(k.name, k.email, pw, portal),
      });
    }

    // Erst die Passwörter speichern, dann senden - sonst käme ein Passwort an,
    // das nicht gilt.
    for (const u of updates) {
      await supabase.from("kundenzugaenge")
        .update({ passwort_salt: u.passwort_salt, passwort_hash: u.passwort_hash, fehlversuche: 0, gesperrt_bis: null })
        .eq("id", u.id);
    }

    try {
      await new Resend(process.env.RESEND_API_KEY).batch.send(mails);
    } catch (err) {
      res.status(500).json({ error: `Versand fehlgeschlagen: ${err.message}. Es wurde nichts als gesendet markiert.` });
      return;
    }

    await supabase.from("kundenzugaenge")
      .update({ info_gesendet_am: new Date().toISOString() })
      .in("id", konten.map(k => k.id));

    res.status(200).json({ ok: true, gesendet: konten.length, von: ICH });
    return;
  }

  res.status(400).json({ error: `Unbekannte action: "${action}"` });
};

/* ------------------------------------------------------- Willkommensmail */
function willkommensMail(name, email, passwort, portal) {
  const e = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const leiter = process.env.ABTEILUNGSLEITER || "Cristian Gambale";
  return `
  <div style="font-family:Verdana,Geneva,sans-serif; color:#333; max-width:580px; font-size:14px; line-height:1.7;">
    <p>Guten Tag ${e(name)}</p>
    <p>Ab sofort erledigen Sie alle Anliegen rund um Ihre Reinigung bequem online. Im neuen Clean Service
    Kundenportal sagen Sie Termine ab, melden Ferienabwesenheiten, verschieben eine Reinigung auf einen
    Ersatztermin mit unserem Springerteam, erfassen Reklamationen und Schäden und fragen Zusatzarbeiten wie
    eine Fensterreinigung an. Das dauert rund zwei Minuten, und Sie erhalten sofort eine Bestätigung.</p>

    <div style="margin:24px 0; padding:18px 20px; background:#F2F9F9; border-left:3px solid #2BB6B7;">
      <div style="font-size:12px; color:#767676;">Portal</div>
      <div style="font-weight:bold; margin-bottom:10px;"><a href="${e(portal)}" style="color:#12797A;">${e(portal.replace(/^https?:\/\//, ""))}</a></div>
      <div style="font-size:12px; color:#767676;">Anmelde-ID</div>
      <div style="font-weight:bold; margin-bottom:10px;">${e(email)}</div>
      <div style="font-size:12px; color:#767676;">Ihr Erstpasswort</div>
      <div style="font-weight:bold; font-size:18px; letter-spacing:2px; font-family:Consolas,monospace;">${e(passwort)}</div>
    </div>

    <p style="margin:24px 0;">
      <a href="${e(portal)}" style="background:#2BB6B7; color:#fff; text-decoration:none;
         padding:13px 24px; border-radius:8px; font-weight:bold; display:inline-block;">Jetzt anmelden</a>
    </p>

    <p>Beim ersten Anmelden legen Sie ein eigenes Passwort fest, danach bleiben Sie auf Ihrem Gerät angemeldet.
    Absagen, Terminverschiebungen, Reklamationen und Schadenmeldungen nehmen wir künftig ausschliesslich über
    das Kundenportal entgegen. So gelangt Ihr Anliegen ohne Umweg an die richtige Stelle, und Sie sehen jederzeit,
    wie weit die Bearbeitung ist.</p>

    <p>Vielen Dank für Ihr Vertrauen. Bei Fragen erreichen Sie uns unter 0844 355 355.</p>

    <p>Freundliche Grüsse<br><br>${e(leiter)}<br>Abteilungsleiter Putzfrauenservice<br>Clean Service Scaramuzzo AG</p>
    <p style="color:#767676; font-size:12px; margin-top:20px;">
      Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · 0844 355 355</p>
  </div>`;
}
