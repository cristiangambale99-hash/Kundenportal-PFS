/**
 * Geschäftsregeln des Kundenportals an einer Stelle.
 *
 * Alles, was das Portal ohne Zutun des Teams entscheidet, steht hier:
 * Fristen, Verrechnung gemäss AGB, Datumsprüfungen. Wer eine Regel ändern
 * will, ändert sie hier - nirgends sonst.
 *
 * Zeitzone ist immer Europe/Zurich, auch wenn der Server anderswo läuft.
 */

const TZ = "Europe/Zurich";

/* Reinigungen finden zwischen 08.00 und 17.00 Uhr statt. Solange Aduna die
   genaue Einsatzzeit nicht liefert, rechnen wir mit beiden Rändern. */
const EINSATZ_FRUEHESTENS = 8;
const EINSATZ_SPAETESTENS = 17;

/** Heutiges Datum in Zürich als "YYYY-MM-DD", optional um n Tage verschoben. */
function datumZuerich(offsetTage = 0) {
  const d = new Date(Date.now() + offsetTage * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

/** Abstand der Zürcher Zeit zu UTC in Millisekunden zu einem Zeitpunkt. */
function zuerichOffset(ts) {
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ts)).map(p => [p.type, p.value])
  );
  const alsUtc = Date.UTC(+teile.year, +teile.month - 1, +teile.day, +teile.hour, +teile.minute, +teile.second);
  return alsUtc - ts;
}

/** Zeitpunkt (ms) für ein Zürcher Datum "YYYY-MM-DD" und eine volle Stunde. */
function zuerichZeitpunkt(isoDatum, stunde) {
  const [j, m, t] = isoDatum.split("-").map(Number);
  const naiv = Date.UTC(j, m - 1, t, stunde);
  return naiv - zuerichOffset(naiv);
}

function istIsoDatum(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

/** "2026-09-23" -> "23.09.2026" */
function datumCH(iso) {
  if (!istIsoDatum(iso)) return iso || "";
  const [j, m, t] = iso.split("-");
  return `${t}.${m}.${j}`;
}

/* ------------------------------------------------ Verrechnung (AGB Ziff. 4)
   Absage mindestens 24 Stunden vorher: kostenlos.
   Weniger als 24 Stunden: 50 %. Weniger als 4 Stunden: 100 %.            */
function stufe(stunden) {
  if (stunden >= 24) return "kostenlos";
  if (stunden >= 4) return "50";
  return "100";
}

/**
 * Bewertet eine Absage nach AGB.
 * Ohne genaue Einsatzzeit prüfen wir beide Ränder des Einsatzfensters:
 * ergeben beide dieselbe Stufe, ist das Ergebnis sicher. Sonst "pruefen" -
 * dann entscheidet die Einsatzzeit aus Aduna, nicht eine Annahme zulasten
 * der Kundschaft.
 */
function verrechnungAbsage(terminIso, jetzt = Date.now()) {
  const frueh = (zuerichZeitpunkt(terminIso, EINSATZ_FRUEHESTENS) - jetzt) / 3600000;
  const spaet = (zuerichZeitpunkt(terminIso, EINSATZ_SPAETESTENS) - jetzt) / 3600000;
  const a = stufe(frueh), b = stufe(spaet);
  return {
    vorlauf_stunden: Math.round(frueh * 10) / 10,
    verrechnung: a === b ? a : "pruefen",
  };
}

/* ------------------------------------------------------ Eingabeprüfung */
/**
 * Prüft die Angaben je Kategorie. Gibt { fehler } oder { daten } zurück.
 * Die Texte gehen 1:1 an die Kundschaft.
 */
function pruefeMeldung(kategorie, b) {
  const heute = datumZuerich(0);
  const gestern = datumZuerich(-1);
  const morgen = datumZuerich(1);
  const txt = s => String(s || "").trim().slice(0, 4000);

  if (kategorie === "verschiebung") {
    if (!istIsoDatum(b.termin_datum)) return { fehler: "Bitte wählen Sie den Termin, der verschoben werden soll." };
    if (!istIsoDatum(b.termin_neu)) return { fehler: "Bitte wählen Sie Ihr Wunschdatum für den Ersatztermin." };
    if (b.termin_datum < heute) return { fehler: "Der zu verschiebende Termin liegt in der Vergangenheit." };
    if (b.termin_neu < morgen) return { fehler: "Der Ersatztermin muss frühestens morgen sein." };
    if (b.termin_neu === b.termin_datum) return { fehler: "Der Ersatztermin muss sich vom ursprünglichen Termin unterscheiden." };
    return { daten: { termin_datum: b.termin_datum, termin_neu: b.termin_neu, kommentar: txt(b.kommentar) } };
  }

  if (kategorie === "absage") {
    if (!istIsoDatum(b.termin_datum)) return { fehler: "Bitte wählen Sie den Termin, der entfallen soll." };
    if (b.termin_datum < heute) return { fehler: "Dieser Termin liegt in der Vergangenheit." };
    let bis = null;
    if (b.zeitraum_bis) {
      if (!istIsoDatum(b.zeitraum_bis)) return { fehler: "Bitte geben Sie an, bis wann die Reinigungen entfallen." };
      if (b.zeitraum_bis < b.termin_datum) return { fehler: "Das Enddatum liegt vor dem Startdatum." };
      bis = b.zeitraum_bis;
    }
    return { daten: { termin_datum: b.termin_datum, zeitraum_bis: bis, kommentar: txt(b.kommentar) } };
  }

  if (kategorie === "reklamation") {
    if (!istIsoDatum(b.reinigungsdatum)) return { fehler: "Bitte geben Sie das Datum der betroffenen Reinigung an." };
    if (b.reinigungsdatum > heute) return { fehler: "Das Datum der Reinigung liegt in der Zukunft." };
    if (b.reinigungsdatum < gestern) {
      return { fehler: "Reklamationen nehmen wir innert 24 Stunden nach der Reinigung entgegen. Für diese Reinigung ist die Frist leider abgelaufen." };
    }
    if (!["nachreinigung", "gespraech"].includes(b.reklamation_wunsch)) {
      return { fehler: "Bitte wählen Sie, wie wir vorgehen sollen: Nachreinigung oder Gespräch." };
    }
    if (!txt(b.beschreibung)) return { fehler: "Bitte beschreiben Sie kurz, was vorgefallen ist." };
    return { daten: { reinigungsdatum: b.reinigungsdatum, reklamation_wunsch: b.reklamation_wunsch, beschreibung: txt(b.beschreibung) } };
  }

  if (kategorie === "schaden") {
    if (!istIsoDatum(b.reinigungsdatum)) return { fehler: "Bitte geben Sie das Datum der betroffenen Reinigung an." };
    if (b.reinigungsdatum > heute) return { fehler: "Das Datum der Reinigung liegt in der Zukunft." };
    if (!txt(b.beschreibung)) return { fehler: "Bitte beschreiben Sie kurz, was vorgefallen ist." };
    return { daten: { reinigungsdatum: b.reinigungsdatum, beschreibung: txt(b.beschreibung) } };
  }

  if (kategorie === "zusatz") {
    const arten = ["fenster", "grund", "umzug", "teppich", "sonstiges"];
    const art = arten.includes(b.art) ? b.art : "sonstiges";
    const wunsch = istIsoDatum(b.wunschdatum) ? b.wunschdatum : null;
    return { daten: { art, wunschdatum: wunsch, kommentar: txt(b.kommentar) } };
  }

  return { fehler: "Unbekannte Kategorie." };
}

const ZUSATZ_ART = {
  fenster: "Fensterreinigung", grund: "Grundreinigung", umzug: "Umzugsreinigung",
  teppich: "Teppich-/Polsterreinigung", sonstiges: "Sonstiges",
};

const WUNSCH_LABEL = {
  nachreinigung: "Nachreinigung durch das Springerteam",
  gespraech: "Gespräch mit dem Abteilungsleiter",
};

/** Lesbare Zusammenfassung - erscheint im Admin, im Kundenkonto und in Mails. */
function detailsText(kategorie, d) {
  const z = [];
  if (kategorie === "verschiebung") {
    z.push(`Betroffener Termin: ${datumCH(d.termin_datum)}`);
    z.push(`Ersatztermin (Springerteam): ${datumCH(d.termin_neu)}`);
  }
  if (kategorie === "absage") {
    if (d.zeitraum_bis) z.push(`Abwesenheit: ${datumCH(d.termin_datum)} bis ${datumCH(d.zeitraum_bis)} – alle Reinigungen entfallen`);
    else z.push(`Betroffener Termin: ${datumCH(d.termin_datum)}`);
  }
  if (kategorie === "reklamation") {
    z.push(`Datum der Reinigung: ${datumCH(d.reinigungsdatum)}`);
    z.push(`Gewünschtes Vorgehen: ${WUNSCH_LABEL[d.reklamation_wunsch]}`);
    z.push(`Beschreibung: ${d.beschreibung}`);
  }
  if (kategorie === "schaden") {
    z.push(`Datum der Reinigung: ${datumCH(d.reinigungsdatum)}`);
    z.push(`Beschreibung: ${d.beschreibung}`);
  }
  if (kategorie === "zusatz") {
    z.push(`Art: ${ZUSATZ_ART[d.art]}`);
    z.push(`Wunschtermin: ${d.wunschdatum ? datumCH(d.wunschdatum) : "offen"}`);
  }
  if (d.kommentar) z.push(`Bemerkung: ${d.kommentar}`);
  return z.join("\n");
}

module.exports = {
  datumZuerich, datumCH, istIsoDatum, verrechnungAbsage, pruefeMeldung,
  detailsText, ZUSATZ_ART, WUNSCH_LABEL, zuerichZeitpunkt,
};
