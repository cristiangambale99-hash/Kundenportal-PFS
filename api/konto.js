/**
 * /api/konto — Kundenkonto: Anmelden, Passwort setzen, Passwort vergessen.
 *
 *   POST /api/konto?action=login            { email, passwort }
 *   POST /api/konto?action=passwort-setzen   { passwort }          (angemeldet)
 *   POST /api/konto?action=vergessen         { email }
 *   POST /api/konto?action=zuruecksetzen     { token, passwort }
 *   GET  /api/konto?action=ich                                     (angemeldet)
 *   POST /api/konto?action=logout
 *
 * Passwoerter werden mit scrypt gehasht (in Node eingebaut, keine zusaetzliche
 * Abhaengigkeit). Zu jedem Konto gehoert ein eigener Zufallssalt, damit gleiche
 * Passwoerter nicht denselben Hash ergeben.
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

const PORTAL_URL = (process.env.PORTAL_URL || "").replace(/\/$/, "");

/* ------------------------------------------------------------- Passwoerter */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashen(passwort, salt) {
  return crypto.scryptSync(String(passwort), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString("hex");
}

/** Vergleich in konstanter Zeit: verraet nicht, ab welchem Zeichen es abweicht. */
function passtPasswort(passwort, hash, salt) {
  if (!hash || !salt) return false;
  const a = Buffer.from(hashen(passwort, salt), "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Erstpasswort fuer den Vertrag: gut lesbar, ohne verwechselbare Zeichen,
 * damit es sich vom Papier abtippen laesst.
 */
const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function erstpasswortErzeugen() {
  const teil = n => Array.from({ length: n }, () =>
    PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)]).join("");
  return `${teil(4)}-${teil(4)}`;
}

/** Mindestanforderung: 8 Zeichen. Bewusst niedrig gehalten - lange Regeln
 *  fuehren bei dieser Zielgruppe zu Zetteln am Bildschirm. */
function passwortPruefen(pw) {
  const p = String(pw || "");
  if (p.length < 8) return "Das Passwort muss mindestens 8 Zeichen lang sein.";
  if (p.length > 200) return "Das Passwort ist zu lang.";
  return null;
}

/* --------------------------------------------------------------- Sitzungen */
const COOKIE = "kunde_session";
const STUNDEN = 24 * 30;   // 30 Tage: die Kundschaft soll angemeldet bleiben

function sessionGeheim() {
  return process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_KEY || "cs-portal";
}

function sessionErzeugen(kontoId) {
  const ablauf = Date.now() + STUNDEN * 3600 * 1000;
  const wert = `${kontoId}.${ablauf}`;
  const sig = crypto.createHmac("sha256", sessionGeheim()).update(wert).digest("hex").slice(0, 32);
  return `${wert}.${sig}`;
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

function cookieSetzen(res, kontoId) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=${sessionErzeugen(kontoId)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STUNDEN * 3600}`);
}
function cookieLoeschen(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

/* ------------------------------------------------------------------ E-Mail */
async function mailSenden(an, betreff, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY ist nicht gesetzt.");
  return new Resend(apiKey).emails.send({
    from: ABSENDER,
    to: an, subject: betreff, html,
  });
}

function fusszeile() {
  return `<p style="color:#7c8c8b; font-size:12.5px; margin-top:26px;">
    Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · 0844 355 355
  </p>`;
}


/* ------------------------------------------------------- Verwaltungskonto */
// Das Team meldet sich ueber dieselbe Maske an wie die Kundschaft, landet
// danach aber im Adminbereich. Die Sitzung muss exakt so signiert sein wie in
// admin.js - sonst wuerde admin.js sie nicht anerkennen.
const ADMIN_ID = "verwaltung";
const ADMIN_COOKIE = "admin_session";
const ADMIN_STUNDEN = 12;

function adminSign(value) {
  return crypto.createHmac("sha256", process.env.ADMIN_PASSWORD || "").update(value).digest("hex");
}

function adminCookie() {
  const ablauf = Date.now() + ADMIN_STUNDEN * 60 * 60 * 1000;
  const wert = `${ablauf}.${adminSign(String(ablauf))}`;
  return `${ADMIN_COOKIE}=${wert}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ADMIN_STUNDEN * 3600}`;
}

/* ---------------------------------------------------------------- Sperrung */
const MAX_FEHLVERSUCHE = 5;
const SPERRE_MINUTEN = 15;

/* ----------------------------------------------------------------- Handler */
module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || "";
  const body = req.body || {};

  // Alles im try: fehlt eine Umgebungsvariable, soll die Kundschaft eine
  // lesbare Meldung sehen statt einer Absturzseite von Vercel.
  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    console.error("konto.js: Supabase nicht erreichbar -", err.message);
    res.status(500).json({
      error: "Das Portal ist gerade nicht erreichbar. Bitte später erneut versuchen oder anrufen: 0844 355 355.",
      detail: err.message,
    });
    return;
  }

  try {
    /* ---------------------------------------------------------- Anmelden --- */
    if (action === "login") {
      if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

      const email = String(body.email || "").trim().toLowerCase();
      const passwort = String(body.passwort || "");
      if (!email || !passwort) {
        res.status(400).json({ error: "Bitte E-Mail-Adresse und Passwort eingeben." });
        return;
      }

      /* Verwaltungskonto: gleiche Maske, aber Weiterleitung in den Adminbereich. */
      if (email === ADMIN_ID) {
        // admin.js vergleicht ebenfalls getrimmt - sonst wuerde ein versehentliches
        // Leerzeichen in der Umgebungsvariablen die beiden Wege auseinanderlaufen lassen.
        const soll = (process.env.ADMIN_PASSWORD || "").trim();
        const ist = passwort.trim();

        if (!soll) {
          // Eigene Meldung: sonst sucht man den Fehler beim Passwort, obwohl
          // schlicht die Umgebungsvariable fehlt.
          console.error("konto.js: ADMIN_PASSWORD ist nicht gesetzt.");
          res.status(500).json({ error: "Verwaltungszugang ist auf dem Server nicht eingerichtet (ADMIN_PASSWORD fehlt)." });
          return;
        }

        const a = Buffer.from(ist);
        const b = Buffer.from(soll);
        const passt = a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!passt) {
          res.status(401).json({ error: "Passwort für die Verwaltung stimmt nicht." });
          return;
        }

        res.setHeader("Set-Cookie", adminCookie());
        res.status(200).json({ ok: true, admin: true, ziel: "/admin.html" });
        return;
      }

      const { data: konto } = await supabase
        .from("kundenzugaenge")
        .select("*")
        .ilike("email", email)
        .maybeSingle();

      // Immer dieselbe Meldung: verraet nicht, ob die Adresse bei uns existiert.
      const abgelehnt = { error: "E-Mail-Adresse oder Passwort stimmt nicht." };

      if (!konto || !konto.aktiv) { res.status(401).json(abgelehnt); return; }

      if (konto.gesperrt_bis && new Date(konto.gesperrt_bis) > new Date()) {
        const min = Math.ceil((new Date(konto.gesperrt_bis) - new Date()) / 60000);
        res.status(429).json({
          error: `Zu viele Fehlversuche. Bitte in ${min} Minute${min === 1 ? "" : "n"} erneut versuchen oder anrufen: 0844 355 355.`,
        });
        return;
      }

      if (!passtPasswort(passwort, konto.passwort_hash, konto.passwort_salt)) {
        const versuche = (konto.fehlversuche || 0) + 1;
        const update = { fehlversuche: versuche };
        if (versuche >= MAX_FEHLVERSUCHE) {
          update.gesperrt_bis = new Date(Date.now() + SPERRE_MINUTEN * 60000).toISOString();
          update.fehlversuche = 0;
        }
        await supabase.from("kundenzugaenge").update(update).eq("id", konto.id);
        res.status(401).json(abgelehnt);
        return;
      }

      await supabase.from("kundenzugaenge").update({
        fehlversuche: 0, gesperrt_bis: null, letzter_login: new Date().toISOString(),
      }).eq("id", konto.id);

      cookieSetzen(res, konto.id);
      res.status(200).json({
        ok: true,
        passwortSetzen: !konto.passwort_gesetzt,   // Erstpasswort -> eigenes waehlen
        kunde: {
          name: konto.name, email: konto.email,
          objekt_id: konto.objekt_id, adresse: konto.adresse,
        },
      });
      return;
    }

    /* ------------------------------------------------------- Wer bin ich --- */
    if (action === "ich") {
      const kontoId = sessionLesen(req);
      if (!kontoId) { res.status(401).json({ error: "Nicht angemeldet." }); return; }

      const { data: konto } = await supabase
        .from("kundenzugaenge")
        .select("id, name, email, objekt_id, adresse, aktiv, passwort_gesetzt")
        .eq("id", kontoId)
        .maybeSingle();

      if (!konto || !konto.aktiv) { cookieLoeschen(res); res.status(401).json({ error: "Nicht angemeldet." }); return; }

      res.status(200).json({
        ok: true,
        passwortSetzen: !konto.passwort_gesetzt,
        kunde: {
          name: konto.name, email: konto.email,
          objekt_id: konto.objekt_id, adresse: konto.adresse,
        },
      });
      return;
    }

    /* -------------------------------------------- Eigenes Passwort setzen --- */
    if (action === "passwort-setzen") {
      if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

      const kontoId = sessionLesen(req);
      if (!kontoId) { res.status(401).json({ error: "Nicht angemeldet." }); return; }

      const fehler = passwortPruefen(body.passwort);
      if (fehler) { res.status(400).json({ error: fehler }); return; }

      const salt = crypto.randomBytes(16).toString("hex");
      const { error } = await supabase.from("kundenzugaenge").update({
        passwort_salt: salt,
        passwort_hash: hashen(body.passwort, salt),
        passwort_gesetzt: true,
        reset_hash: null,
        reset_ablauf: null,
      }).eq("id", kontoId);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.status(200).json({ ok: true });
      return;
    }

    /* ---------------------------------------------------- Passwort vergessen --- */
    if (action === "vergessen") {
      if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

      const email = String(body.email || "").trim().toLowerCase();
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null;

      // Immer dieselbe Antwort, egal ob die Adresse existiert: sonst liesse sich
      // herausfinden, wer bei uns Kunde ist.
      const antwort = {
        ok: true,
        hinweis: "Falls diese Adresse bei uns hinterlegt ist, haben wir Ihnen soeben einen Link zum Zurücksetzen geschickt.",
      };

      if (!email || !email.includes("@")) {
        res.status(400).json({ error: "Bitte geben Sie eine gültige E-Mail-Adresse an." });
        return;
      }

      /* Konfiguration zuerst prüfen, vor der Suche nach dem Konto.
         So verrät die Fehlermeldung nicht, ob die Adresse bei uns existiert -
         sie erscheint für jede Eingabe gleich. Ohne diese Prüfung liefe der
         Aufruf durch, die Mail scheiterte still, und die Kundschaft sähe eine
         Erfolgsmeldung ohne Mail im Postfach. */
      if (!process.env.RESEND_API_KEY) {
        console.error("konto.js: RESEND_API_KEY ist nicht gesetzt - keine Reset-Mail möglich.");
        res.status(500).json({
          error: "Der Mailversand ist auf dem Server nicht eingerichtet. Bitte rufen Sie uns an: 0844 355 355.",
          detail: "RESEND_API_KEY fehlt",
        });
        return;
      }

      // Höchstens 3 Anfragen pro Stunde und Adresse
      const seit = new Date(Date.now() - 3600 * 1000).toISOString();
      const { count } = await supabase
        .from("passwort_reset_log")
        .select("id", { count: "exact", head: true })
        .ilike("email", email)
        .gte("created_at", seit);

      if ((count || 0) >= 3) { res.status(200).json(antwort); return; }
      await supabase.from("passwort_reset_log").insert({ email, ip });

      const { data: konto } = await supabase
        .from("kundenzugaenge")
        .select("id, name, email, aktiv")
        .ilike("email", email)
        .maybeSingle();

      if (konto && konto.aktiv) {
        const token = crypto.randomBytes(32).toString("hex");
        await supabase.from("kundenzugaenge").update({
          reset_hash: crypto.createHash("sha256").update(token).digest("hex"),
          reset_ablauf: new Date(Date.now() + 60 * 60 * 1000).toISOString(),   // 1 Stunde
        }).eq("id", konto.id);

        const link = `${PORTAL_URL}/?reset=${token}`;
        try {
          await mailSenden(konto.email, "Passwort zurücksetzen — Kundenportal", `
            <p>Guten Tag ${konto.name || ""}</p>
            <p>Sie haben ein neues Passwort für das Kundenportal angefordert.</p>
            <p style="margin:22px 0;">
              <a href="${link}" style="background:#2bb6b7; color:#ffffff; text-decoration:none;
                 padding:14px 24px; border-radius:9px; font-weight:600; display:inline-block;">
                Neues Passwort festlegen
              </a>
            </p>
            <p style="font-size:13px; color:#5b6b76;">
              Der Link ist eine Stunde lang gültig. Falls Sie das nicht waren, können Sie
              diese Nachricht ignorieren — Ihr bisheriges Passwort bleibt gültig.
            </p>
            ${fusszeile()}
          `);
        } catch (err) {
          // Technische Störung, nicht "Adresse unbekannt": darf gemeldet werden,
          // damit niemand vergeblich auf eine Mail wartet.
          console.error("konto.js: Reset-Mail fehlgeschlagen -", err.message);
          res.status(502).json({
            error: "Der Link konnte nicht zugestellt werden. Bitte versuchen Sie es später erneut oder rufen Sie uns an: 0844 355 355.",
            detail: String(err.message || "").slice(0, 300),
          });
          return;
        }
      }

      res.status(200).json(antwort);
      return;
    }

    /* ------------------------------------------------- Passwort zuruecksetzen --- */
    if (action === "zuruecksetzen") {
      if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

      const token = String(body.token || "");
      const fehler = passwortPruefen(body.passwort);
      if (fehler) { res.status(400).json({ error: fehler }); return; }
      if (!token) { res.status(400).json({ error: "Kein gültiger Link." }); return; }

      const hash = crypto.createHash("sha256").update(token).digest("hex");
      const { data: konto } = await supabase
        .from("kundenzugaenge")
        .select("id, aktiv, reset_ablauf")
        .eq("reset_hash", hash)
        .maybeSingle();

      if (!konto || !konto.aktiv || !konto.reset_ablauf || new Date(konto.reset_ablauf) < new Date()) {
        res.status(400).json({
          error: "Dieser Link ist abgelaufen oder wurde bereits verwendet. Bitte fordern Sie einen neuen an.",
        });
        return;
      }

      const salt = crypto.randomBytes(16).toString("hex");
      await supabase.from("kundenzugaenge").update({
        passwort_salt: salt,
        passwort_hash: hashen(body.passwort, salt),
        passwort_gesetzt: true,
        reset_hash: null,
        reset_ablauf: null,
        fehlversuche: 0,
        gesperrt_bis: null,
        letzter_login: new Date().toISOString(),
      }).eq("id", konto.id);

      cookieSetzen(res, konto.id);
      res.status(200).json({ ok: true });
      return;
    }

    /* --------------------------------------------- Eigene Meldungen --- */
    if (action === "meldungen") {
      const kontoId = sessionLesen(req);
      if (!kontoId) { res.status(401).json({ error: "Nicht angemeldet." }); return; }

      const { data: konto } = await supabase
        .from("kundenzugaenge")
        .select("email, objekt_id, aktiv")
        .eq("id", kontoId)
        .maybeSingle();

      if (!konto || !konto.aktiv) { res.status(401).json({ error: "Nicht angemeldet." }); return; }

      // Streng auf die eigene E-Mail eingegrenzt. Nicht ueber die Objektnummer:
      // die ist erratbar, die Sitzung dagegen nicht.
      const { data, error } = await supabase
        .from("meldungen")
        .select("id, kategorie, details, status, admin_note, created_at")
        .ilike("email", konto.email)
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.status(200).json({ ok: true, meldungen: data || [] });
      return;
    }

    /* ---------------------------------------------------------- Abmelden --- */
    if (action === "logout") {
      cookieLoeschen(res);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: `Unbekannte action: "${action}"` });

  } catch (err) {
    console.error("konto.js:", err);
    res.status(500).json({ error: "Es ist ein Fehler aufgetreten. Bitte später erneut versuchen." });
  }
};
