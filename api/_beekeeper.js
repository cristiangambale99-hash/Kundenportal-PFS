/**
 * Beekeeper-Anbindung - von melde.js und admin.js gemeinsam genutzt.
 *
 * Zuordnung Kunde <-> Gruppenchat läuft automatisch über den Chatnamen:
 * Eure Kundenchats heissen "Vorname Nachname PFS <Kundennummer>". Sobald der
 * Bot Mitglied eines Chats ist, erkennt das Portal die Nummer und verknüpft
 * den Chat selbst - beim ersten Bedarf (Meldung) und täglich per Cron.
 * Von Hand muss nur eingegriffen werden, wenn ein Chat anders heisst.
 */

function basis() {
  const url = (process.env.BEEKEEPER_TENANT_URL || "").replace(/\/$/, "");
  const token = process.env.BEEKEEPER_API_TOKEN || "";
  if (!url || !token) throw new Error("BEEKEEPER_TENANT_URL oder BEEKEEPER_API_TOKEN ist bei Vercel nicht gesetzt.");
  return { url, headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" } };
}

/** Alle Gruppenchats, in denen der Bot Mitglied ist (bestätigt: GET /api/2/chats/groups). */
async function chatsLaden() {
  const { url, headers } = basis();
  const alle = [];
  for (let offset = 0, runde = 0; runde < 20; runde++, offset += 100) {
    const r = await fetch(`${url}/api/2/chats/groups?limit=100&offset=${offset}`, { headers });
    if (r.status === 401 || r.status === 403) throw new Error(`Beekeeper lehnt den Token ab (${r.status}). Bitte BEEKEEPER_API_TOKEN prüfen.`);
    if (!r.ok) throw new Error(`Beekeeper ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const liste = Array.isArray(d) ? d : (d.data || d.results || d.chats || d.groups || []);
    liste.forEach(c => alle.push({
      id: String(c.id || c.chat_id || c.uuid || ""),
      name: c.name || c.title || c.display_name || "(ohne Namen)",
    }));
    if (liste.length < 100) break;
  }
  const gesehen = new Set();
  return alle.filter(c => c.id && !gesehen.has(c.id) && gesehen.add(c.id));
}

async function senden(chatId, text) {
  const { url, headers } = basis();
  const r = await fetch(`${url}/api/2/chats/groups/${encodeURIComponent(chatId)}/messages`, {
    method: "POST", headers, body: JSON.stringify({ body: text }),
  });
  if (!r.ok) throw new Error(`Beekeeper ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/** "Alessia Gambale PFS 4168" -> "4168" (führende Nullen entfernt) */
function objektAusName(name) {
  const m = String(name || "").match(/\bPFS\s*[-:#]?\s*0*(\d{1,6})\b/i);
  return m ? m[1] : null;
}
const norm = n => String(n || "").trim().replace(/^0+(?=\d)/, "");

async function speichern(supabase, objekt, chat) {
  await supabase.from("objekt_beekeeper_mapping").upsert({
    objekt_id: objekt, kunde: chat.name, beekeeper_chat_id: chat.id,
    status: "matched", updated_at: new Date().toISOString(),
  }, { onConflict: "objekt_id" });
  await supabase.from("meldungen").update({ zuordnung_offen: false }).eq("objekt_id", objekt);
}

/**
 * Chat für ein Objekt: zuerst aus der Zuordnung, sonst automatisch über den
 * Chatnamen suchen und die Zuordnung gleich speichern. Bei mehreren Treffern
 * wird nicht geraten.
 * -> { chatId } | { fehlt: "grund" }
 */
async function chatFuerObjekt(supabase, objektId) {
  const objekt = norm(objektId);
  if (!objekt) return { fehlt: "keine Kundennummer" };

  const { data: vorhanden } = await supabase.from("objekt_beekeeper_mapping")
    .select("beekeeper_chat_id, status").eq("objekt_id", objekt).maybeSingle();
  if (vorhanden && vorhanden.status === "matched" && vorhanden.beekeeper_chat_id) {
    return { chatId: vorhanden.beekeeper_chat_id };
  }

  const treffer = (await chatsLaden()).filter(c => objektAusName(c.name) === objekt);
  if (treffer.length === 1) {
    await speichern(supabase, objekt, treffer[0]);
    return { chatId: treffer[0].id, neu_zugeordnet: true };
  }
  return { fehlt: treffer.length > 1 ? `mehrere Chats mit PFS ${objekt}` : `kein Chat mit „PFS ${objekt}“, in dem der Bot Mitglied ist` };
}

/** Täglicher Abgleich: alle Chats mit erkennbarer Nummer zuordnen. */
async function alleAbgleichen(supabase) {
  const chats = await chatsLaden();
  const { data: map } = await supabase.from("objekt_beekeeper_mapping").select("objekt_id, beekeeper_chat_id, status");
  const zugeordnet = new Set((map || []).filter(m => m.status === "matched" && m.beekeeper_chat_id).map(m => m.objekt_id));

  const proNummer = {};
  chats.forEach(c => { const n = objektAusName(c.name); if (n) (proNummer[n] = proNummer[n] || []).push(c); });

  let neu = 0, doppelt = [];
  for (const [nr, liste] of Object.entries(proNummer)) {
    if (zugeordnet.has(nr)) continue;
    if (liste.length > 1) { doppelt.push(nr); continue; }
    await speichern(supabase, nr, liste[0]);
    neu++;
  }
  const ohneNummer = chats.filter(c => !objektAusName(c.name)).map(c => c.name);
  return { chats: chats.length, neu_zugeordnet: neu, doppelt, ohne_nummer: ohneNummer };
}

module.exports = { chatsLaden, senden, objektAusName, chatFuerObjekt, alleAbgleichen };
