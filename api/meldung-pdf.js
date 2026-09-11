/**
 * Erzeugt aus einer Reklamation oder Schadenmeldung ein PDF auf dem
 * Briefpapier der Clean Service Scaramuzzo AG.
 *
 * Die Fotos werden direkt eingebettet und danach verworfen - sie werden
 * nirgends dauerhaft gespeichert. Das Dokument in eurem Postfach ist die
 * Ablage.
 */

const { jsPDF } = require("jspdf");
const { BP_LOGO, BP_SEITE, BP_FUSS, BP } = require("./briefpapier.js");

const F = {
  ink:    [51, 51, 51],
  mute:   [118, 118, 118],
  teal:   [43, 182, 183],
  dunkel: [18, 121, 122],
};

const TITEL = {
  reklamation: "Reklamation",
  schaden:     "Schadenmeldung",
};

/**
 * @param {object} m
 *   kategorie, name, objekt_id, adresse, email,
 *   reinigungsdatum, beschreibung, fotos (Array von Data-URLs)
 * @returns {Buffer} das fertige PDF
 */
function meldungPdf(m) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const L = BP.rand.links;
  const W = 210 - BP.rand.links - BP.rand.rechts;
  const UNTEN = 262;              // ab hier beginnt die Fusszeile

  function briefpapier() {
    doc.addImage("data:image/png;base64," + BP_LOGO,  "PNG", BP.logo.x,  BP.logo.y,  BP.logo.w,  BP.logo.h);
    doc.addImage("data:image/png;base64," + BP_SEITE, "PNG", BP.seite.x, BP.seite.y, BP.seite.w, BP.seite.h);
    doc.addImage("data:image/png;base64," + BP_FUSS,  "PNG", BP.fuss.x,  BP.fuss.y,  BP.fuss.w,  BP.fuss.h);
  }

  briefpapier();
  let y = BP.rand.oben;

  /** Sorgt fuer genug Platz - sonst laeuft der Text in die Fusszeile. */
  function platz(hoehe) {
    if (y + hoehe > UNTEN) {
      doc.addPage();
      briefpapier();
      y = BP.rand.oben;
    }
  }

  function kapitel(t) {
    platz(12);
    doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...F.teal);
    doc.text(String(t).toUpperCase(), L, y);
    y += 6;
  }

  function absatz(t, groesse) {
    doc.setFont("helvetica", "normal").setFontSize(groesse || 9).setTextColor(...F.ink);
    const zeilen = doc.splitTextToSize(String(t || "-"), W);
    zeilen.forEach(z => {
      platz(5);
      doc.text(z, L, y);
      y += 4.1;
    });
    y += 3;
  }

  function zeile(label, wert) {
    platz(6);
    doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(...F.ink);
    doc.text(String(label), L, y);
    doc.setFont("helvetica", "normal").setTextColor(...F.mute);
    doc.text(String(wert || "-"), L + 42, y);
    y += 5.4;
  }

  /* ---- Kopf ---- */
  const titel = TITEL[m.kategorie] || "Meldung";
  doc.setFont("helvetica", "bold").setFontSize(17).setTextColor(...F.dunkel);
  doc.text(titel, L, y);
  y += 7;

  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...F.mute);
  doc.text(`Eingegangen über das Kundenportal am ${new Date().toLocaleString("de-CH", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  })}`, L, y);
  y += 10;

  /* ---- Kundendaten ---- */
  kapitel("Kundschaft");
  zeile("Name", m.name);
  zeile("Kundennummer", m.objekt_id);
  zeile("Adresse", m.adresse);
  zeile("E-Mail", m.email);
  y += 4;

  /* ---- Betroffene Reinigung ---- */
  kapitel("Betroffene Reinigung");
  zeile("Datum der Reinigung", m.reinigungsdatum);
  y += 4;

  /* ---- Schilderung ---- */
  kapitel(m.kategorie === "schaden" ? "Schilderung des Schadens" : "Schilderung der Reklamation");
  absatz(m.beschreibung);
  y += 2;

  /* ---- Fotos ----
     Zeilenweise gesetzt: erst die Masse aller Bilder einer Zeile bestimmen,
     dann die Zeilenhoehe auf das hoechste Bild legen. Sonst ueberlappen
     Hoch- und Querformat, sobald sie nebeneinander stehen. */
  const fotos = Array.isArray(m.fotos) ? m.fotos.filter(Boolean) : [];
  if (fotos.length) {
    kapitel(`Fotos (${fotos.length})`);

    const spalten = 2;
    const abstand = 6;
    const breite = (W - abstand * (spalten - 1)) / spalten;

    // Masse vorab lesen; unlesbare Bilder fallen still weg
    const bilder = [];
    fotos.forEach(foto => {
      try {
        const p = doc.getImageProperties(foto);
        bilder.push({ foto, hoehe: (p.height / p.width) * breite });
      } catch (err) {
        console.error("meldung-pdf: Foto konnte nicht gelesen werden -", err.message);
      }
    });

    for (let i = 0; i < bilder.length; i += spalten) {
      const zeileBilder = bilder.slice(i, i + spalten);
      const zeilenHoehe = Math.max(...zeileBilder.map(b => b.hoehe));
      platz(zeilenHoehe + abstand);

      zeileBilder.forEach((b, s) => {
        const x = L + s * (breite + abstand);
        try {
          doc.addImage(b.foto, "JPEG", x, y, breite, b.hoehe);
          doc.setDrawColor(220, 228, 228).setLineWidth(0.2);
          doc.rect(x, y, breite, b.hoehe);
        } catch (err) {
          console.error("meldung-pdf: Foto konnte nicht eingefügt werden -", err.message);
        }
      });

      y += zeilenHoehe + abstand;
    }
    y += 2;
  }

  /* ---- Bearbeitungsvermerk ---- */
  platz(30);
  doc.setDrawColor(207, 231, 231).setLineWidth(0.2);
  doc.line(L, y, L + W, y);
  y += 6;
  doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(...F.dunkel);
  doc.text("BEARBEITUNGSVERMERK", L, y);
  y += 6;
  doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...F.mute);
  doc.text("Aufgenommen durch:", L, y);
  doc.text("Datum:", L + 95, y);
  doc.setDrawColor(180, 190, 190).setLineWidth(0.2);
  doc.line(L + 33, y + 0.8, L + 88, y + 0.8);
  doc.line(L + 108, y + 0.8, L + W, y + 0.8);
  y += 9;
  doc.text("Massnahme:", L, y);
  doc.line(L + 22, y + 0.8, L + W, y + 0.8);

  return Buffer.from(doc.output("arraybuffer"));
}

module.exports = { meldungPdf, TITEL };
