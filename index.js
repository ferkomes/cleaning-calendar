// Build version: 2026-09-19-build-3 (Lodgify v2 integration, 5-min sync cooldown, working view switching & logout)
let detailsStatus = "idle";
// idle | processing | done | failed

// --------------------- Green-API WhatsApp & Értesítési Beállítások ---------------------
const GREEN_API_URL = "https://7107.api.greenapi.com";
const GREEN_API_ID_INSTANCE = "710722802966";
const GREEN_API_TOKEN = "51cbdb160011438ebdbf13cef9c18d99111f4e75f6234c5ca3";

const FERI_WHATSAPP = "31629306180@c.us"; // Ferenc - kapja mindet (Golf del Sur + La Arena)
const GOLF_DEL_SUR_CLEANER_WHATSAPP = "34660541568@c.us"; // Golf del Sur takarító (+34 660 54 15 68)
const LA_ARENA_CLEANER_WHATSAPP = "36305757170@c.us"; // La Arena takarító (+36 30 575 7170)

// --------------------- Authentication ---------------------
function authenticateUser(request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return null;
  }
  try {
    const base64Credentials = authHeader.substring(6).trim();
    const decoded = atob(base64Credentials);
    const colonIndex = decoded.indexOf(":");
    if (colonIndex === -1) return null;
    const rawUser = decoded.substring(0, colonIndex).trim();
    const pass = decoded.substring(colonIndex + 1).trim();

    if (rawUser === "invalid_user_logout") {
      return null;
    }

    // 1. Admin (Jelszó: Kurvaanyad1!)
    if (pass === "Kurvaanyad1!") {
      return { role: "admin", username: rawUser || "Admin" };
    }

    // 2. LaArena / Kata (Jelszó: Kata1!)
    if (pass === "Kata1!") {
      return { role: "la-arena", username: "Kata (La-Arena)" };
    }

    // 3. GolfDelSur / Gábor (Jelszó: Gabor1!)
    if (pass === "Gabor1!") {
      return { role: "golf-del-sur", username: "Gábor (Golf-del-Sur)" };
    }

    return null;
  } catch (e) {
    return null;
  }
}

function unauthorizedResponse(msg = "Access Denied: Authentication required.") {
  return new Response(msg, {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Cleaning Calendar", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

// --------------------- Cooldown & Rate Limiting ---------------------
async function checkSyncCooldown(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE name = 'LAST_SYNC_TIME'").first();
    if (!row || !row.value) return { allowed: true };
    const lastSyncMs = new Date(row.value).getTime();
    if (isNaN(lastSyncMs)) return { allowed: true };
    const elapsedSec = Math.floor((Date.now() - lastSyncMs) / 1000);
    const cooldownSec = 300; // 5 perc cooldown
    if (elapsedSec < cooldownSec) {
      const remainingSec = cooldownSec - elapsedSec;
      const mins = Math.floor(remainingSec / 60);
      const secs = remainingSec % 60;
      const timeStr = mins > 0 ? `${mins} perc ${secs} mp` : `${secs} mp`;
      return { allowed: false, remainingSec, timeStr, lastSyncIso: row.value };
    }
    return { allowed: true, lastSyncIso: row.value };
  } catch (e) {
    return { allowed: true };
  }
}

async function markSyncDone(env) {
  try {
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO settings (name, value) VALUES ('LAST_SYNC_TIME', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value"
    ).bind(nowIso).run();
  } catch (e) {
    console.error("Failed to mark sync done:", e);
  }
}

// --------------------- Main Worker Export ---------------------
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const view = url.searchParams.get("view");
      const action = url.searchParams.get("action");
      const host = request.headers.get('host') || 'worker.default.tld';

      // --- ICAL ROUTES (TOKEN NÉLKÜL - Naptár szinkronizációhoz publikus) ---
      if (pathname === "/golf-del-sur-ical" || action === "golf-del-sur-ical") {
        return await serveIcalFeed(env, ["The Tucan", "The Colibri", "The Albatros"], "Golf-del-Sur-Columns", host);
      }
      if (pathname === "/la-arena-ical" || action === "la-arena-ical") {
        return await serveIcalFeed(env, ["The Banana", "The Pirate"], "La-Arena-Columns", host);
      }
      // ---------------------------------------------------------------------

      // HTTP Basic Authentication ellenőrzése
      const auth = authenticateUser(request);

      // Kijelentkezés
      if (action === "logout" || pathname === "/logout") {
        if (auth) {
          return Response.redirect(url.origin + pathname, 302);
        }
        return unauthorizedResponse("Sikeresen kijelentkeztél. Újbóli belépéshez add meg a bejelentkezési adatokat.");
      }

      if (!auth) {
        return unauthorizedResponse();
      }

      // 1. Kliens oldali szinkronizáció előkészítése (Token és szűrési adatok átadása)
      if (action === "start-sync") {
        const cooldown = await checkSyncCooldown(env);
        if (!cooldown.allowed) {
          return new Response(JSON.stringify({
            allowed: false,
            message: `⏳ A naptár nemrég frissült. Újabb frissítés ${cooldown.timeStr} múlva indítható.`
          }), {
            status: 429,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({
          allowed: true,
          apiKey: env.LODGIFY_API_KEY,
          propertiesMap: {
            569854: "The Albatros",
            569855: "The Banana",
            573525: "The Colibri",
            569856: "The Pirate",
            569857: "The Tucan"
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      // 2. Kliens oldali szinkronizált adatok mentése a D1 adatbázisba
      if ((action === "sync-push" || pathname === "/sync-push") && request.method === "POST") {
        try {
          const body = await request.json();
          const rows = body.rows || [];
          if (!Array.isArray(rows) || !rows.length) {
            return new Response(JSON.stringify({ success: false, message: "Nincs mentendő foglalás." }), {
              status: 400,
              headers: { "Content-Type": "application/json" }
            });
          }
          const { unnotifiedBookings } = await getUnnotifiedBookings(env, rows);
          await batchUpsertBookings(env, rows);

          const periodStart = body.periodStart || new Date(Date.now() - 32 * 86400000).toISOString().slice(0, 10);
          const validIds = rows.map(r => r.booking_id);
          const prunedBookings = await pruneStaleBookings(env, validIds, periodStart);

          await markSyncDone(env);
          await logIssue(env, `✅ Sikeres szinkronizáció: ${rows.length} foglalás mentve (${auth.username}).`);
          return new Response(JSON.stringify({
            success: true,
            count: rows.length,
            pendingNotifications: unnotifiedBookings,
            prunedCount: prunedBookings ? prunedBookings.length : 0
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        } catch (err) {
          await logIssue(env, `Sync push error: ${err.message}`);
          return new Response(JSON.stringify({ success: false, message: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
      }

      // 2.1 Értesítések rögzítése (ha kliens oldalon már sikeresen kiküldték a levelet)
      if ((action === "mark-notified" || pathname === "/mark-notified") && request.method === "POST") {
        try {
          const body = await request.json();
          const items = body.items || [];
          for (const it of items) {
            const bId = String(it.booking_id).replace('.0', '');
            await env.DB.prepare(`
              INSERT INTO email_notifications (booking_id, property_name, guest_name, check_in_date, departure, sent_at, recipient, status)
              VALUES (?, ?, ?, ?, ?, datetime('now'), ?, 'sent')
              ON CONFLICT(booking_id) DO UPDATE SET sent_at = excluded.sent_at, status = 'sent'
            `).bind(
              bId,
              it.property_name || '',
              it.guest_name || '',
              it.check_in_date || '',
              it.departure || '',
              GOLF_DEL_SUR_NOTIFICATION_EMAIL
            ).run();
            await logIssue(env, `📧 Email értesítő sikeresen elküldve új foglalásról: #${bId} (${it.property_name}, ${it.guest_name}) -> ${GOLF_DEL_SUR_NOTIFICATION_EMAIL}`);
          }
          return new Response(JSON.stringify({ success: true, count: items.length }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        } catch (err) {
          await logIssue(env, `Mark notified error: ${err.message}`);
          return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
      }

      // 2.2 Takarítás kész állapot rögzítése és WhatsApp értesítés küldése Feri számára
      if ((action === "toggle-cleaned" || pathname === "/toggle-cleaned") && request.method === "POST") {
        try {
          const body = await request.json();
          const { booking_id, is_done } = body;
          const bId = String(booking_id).replace('.0', '');
          const statusVal = is_done ? 'done' : 'pending';
          const cleanedAt = is_done ? new Date().toISOString() : null;

          await env.DB.prepare(`
            UPDATE bookings
            SET cleaned_status = ?, cleaned_at = ?
            WHERE booking_id = ?
          `).bind(statusVal, cleanedAt, bId).run();

          const booking = await env.DB.prepare("SELECT * FROM bookings WHERE booking_id = ?").bind(bId).first();

          if (is_done && booking) {
            const nowMadrid = new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
            const isLaArena = isLaArenaProperty(booking.property_name);
            const areaName = isLaArena ? "La Arena" : "Golf del Sur";

            const waMsgLines = [
              `✨ *TAKARÍTÁS ELVÉGEZVE!*`,
              ``,
              `📍 *Apartman:* ${booking.property_name} (${areaName})`,
              `🧹 *Státusz:* A takarítás befejeződött, a lakás tiszta és fogadásra kész!`,
              `👤 *Távozó vendég:* ${booking.guest_name || 'Vendég'}`,
              booking.note ? `📝 *Kérés volt:* ${booking.note}` : null,
              `⏰ *Befejezve:* ${nowMadrid} (${auth.username})`
            ].filter(Boolean).join("\n");

            try {
              await fetch(`${GREEN_API_URL}/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chatId: FERI_WHATSAPP,
                  message: waMsgLines
                })
              });
              await logIssue(env, `💬 WhatsApp takarítás kész értesítő elküldve Ferencnek: #${bId} (${booking.property_name})`);
            } catch (waErr) {
              await logIssue(env, `WhatsApp takarítás küldés hiba: ${waErr.message}`);
            }
          }

          return new Response(JSON.stringify({ success: true, booking_id: bId, status: statusVal }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        } catch (err) {
          await logIssue(env, `Toggle cleaned error: ${err.message}`);
          return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
      }

      // 3. Szerver oldali szinkronizáció (Fallback ha a kliens közvetlenül hívná)
      if (pathname === "/update" || action === "update") {
        const cooldown = await checkSyncCooldown(env);
        if (!cooldown.allowed) {
          return new Response(`⏳ A naptár nemrég frissült. Újabb frissítés ${cooldown.timeStr} múlva indítható.`, {
            status: 429,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }

        try {
          await logIssue(env, `Sync manually initiated by ${auth.username}.`);
          detailsStatus = "processing";
          const result = await updateAllBookings(env);
          await markSyncDone(env);
          detailsStatus = "done";
          return new Response(`✅ Szinkronizálás sikeres! (${result.count} foglalás frissítve - ${result.version})`, {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        } catch (err) {
          detailsStatus = "failed";
          await logIssue(env, `Sync update failed: ${err.message}`);
          return new Response("Hiba a szinkronizálás során: " + err.message, {
            status: 500,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
      }

      // Beállítások mentése (csak Admin)
      if ((pathname === "/save-settings" || action === "save-settings") && request.method === "POST") {
        if (auth.role !== "admin") {
          return new Response("Unauthorized", { status: 403 });
        }
        return handleSettingsPost(request, env);
      }

      // Rendszernaplók megtekintése (csak Admin)
      if (pathname === "/logs" || view === "logs") {
        if (auth.role !== "admin") {
          return new Response("Unauthorized", { status: 403 });
        }
        return await serveLogs(env, auth);
      }

      // 1. Szerepkör: Kata (La-Arena) -> Kizárólag Banana és Pirate apartmanok
      if (auth.role === "la-arena") {
        return await serveTable(env, ["The Banana", "The Pirate"], "La-Arena (Kata)", auth, host);
      }

      // 2. Szerepkör: Gábor (Golf-del-Sur) -> Kizárólag Tucan, Colibri, Albatros apartmanok
      if (auth.role === "golf-del-sur") {
        return await serveTable(env, ["The Tucan", "The Colibri", "The Albatros"], "Golf-del-Sur (Gábor)", auth, host);
      }

      // 3. Szerepkör: Admin -> Dinamikus szűrés a nézetek között
      if (pathname === "/la-arena" || view === "la-arena") {
        return await serveTable(env, ["The Banana", "The Pirate"], "La-Arena (Kata)", auth, host);
      }

      if (pathname === "/golf-del-sur" || view === "golf-del-sur") {
        return await serveTable(env, ["The Tucan", "The Colibri", "The Albatros"], "Golf-del-Sur (Gábor)", auth, host);
      }

      // Alapértelmezett nézet Adminnak: Összes apartman (All Bookings)
      return await serveTable(env, [], "All Bookings", auth, host);
    } catch (err) {
      await logIssue(env, `Uncaught error in fetch handler: ${err.message}\nStack: ${err.stack}`);
      return new Response(`Uncaught Exception: ${err.message}\n\nStack:\n${err.stack}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  },

  // CRON trigger
  async scheduled(event, env, ctx) {
    const runTime = new Date(event.scheduledTime);
    const isMainRun = runTime.getUTCMinutes() === 0;

    if (isMainRun) {
      ctx.waitUntil(env.DB.prepare("DELETE FROM logs WHERE timestamp < datetime('now', '-7 days')").run());
      ctx.waitUntil(logIssue(env, `*** Log Cleanup Triggered (Older than 7 days) ***`));
    }

    ctx.waitUntil(logIssue(env, `Automated Cron sync started at ${runTime.toISOString()}.`));
    try {
      await updateAllBookings(env);
      await markSyncDone(env);
    } catch (err) {
      ctx.waitUntil(logIssue(env, `Automated Cron Update failed: ${err.message}`));
    }
  }
};

// --------------------- Lodgify API Integration (v1 Elsődleges & Megbízható) ---------------------
const PROPERTIES_MAP = {
  569854: "The Albatros",
  569855: "The Banana",
  573525: "The Colibri",
  569856: "The Pirate",
  569857: "The Tucan"
};

async function updateAllBookings(env) {
  const apiKey = env.LODGIFY_API_KEY;
  if (!apiKey) throw new Error("LODGIFY_API_KEY nincs beállítva!");

  const headers = {
    "X-ApiKey": apiKey,
    "Accept": "application/json"
  };

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 32);
  const oneYearAhead = new Date();
  oneYearAhead.setFullYear(oneYearAhead.getFullYear() + 1);

  const periodStart = thirtyDaysAgo.toISOString().slice(0, 10);
  const periodEnd = oneYearAhead.toISOString().slice(0, 10);

  let offset = 0;
  const limit = 50;
  const allItems = [];

  while (offset < 400) {
    const url = `https://api.lodgify.com/v1/reservation?offset=${offset}&limit=${limit}&trash=false&periodStart=${periodStart}&periodEnd=${periodEnd}`;
    let resp = await fetch(url, { headers });

    let retries = 0;
    while (resp.status === 429 && retries < 3) {
      const waitMs = 2500 * (retries + 1);
      await logIssue(env, `Lodgify 429 rate limit (offset=${offset}). Waiting ${waitMs}ms before retry #${retries + 1}...`);
      await delay(waitMs);
      resp = await fetch(url, { headers });
      retries++;
    }

    if (!resp.ok) {
      throw new Error(`Lodgify API v1 returned HTTP ${resp.status}`);
    }

    const data = await resp.json();
    if (!data || !data.items || !data.items.length) break;

    allItems.push(...data.items);
    if (data.items.length < limit) break;
    offset += limit;
    await delay(200);
  }

  // Szűrés: Csak az aktív 'Booked' állapotú foglalások és zárt időszakok (Declined, Cancelled, töröltek kizárva)
  const validBookings = allItems.filter(item => {
    const status = (item.status || "").toLowerCase();
    return status === "booked" && !item.cancellationDate && !item.is_deleted;
  });

  // Notes lekérése Lodgify v2 API-ból
  const notesMap = new Map();
  try {
    let v2Page = 1;
    while (v2Page <= 3) {
      const v2Url = `https://api.lodgify.com/v2/reservations/bookings?page=${v2Page}&size=50&trash=False`;
      const v2Resp = await fetch(v2Url, { headers });
      if (!v2Resp.ok) break;
      const v2Data = await v2Resp.json();
      if (!v2Data || !v2Data.items || !v2Data.items.length) break;
      for (const it of v2Data.items) {
        const noteText = cleanNote(it.notes);
        if (noteText) notesMap.set(String(it.id).replace('.0', ''), noteText);
      }
      if (v2Data.items.length < 50) break;
      v2Page++;
    }
  } catch (err) {
    console.warn("Worker v2 notes fetch warning:", err.message);
  }

  const mappedRows = validBookings.map(item => mapBooking(item, PROPERTIES_MAP, notesMap));

  if (mappedRows.length) {
    const { unnotifiedBookings } = await getUnnotifiedBookings(env, mappedRows);
    await batchUpsertBookings(env, mappedRows);
    const validIds = mappedRows.map(r => r.booking_id);
    await pruneStaleBookings(env, validIds, periodStart);

    if (unnotifiedBookings && unnotifiedBookings.length) {
      await sendNewBookingWhatsAppNotifications(env, unnotifiedBookings);
    }
  }

  await logIssue(env, `✅ Lodgify szinkronizáció sikeres: ${mappedRows.length} aktív foglalás és időszak frissítve.`);
  return { success: true, count: mappedRows.length, version: "v1" };
}

// --------------------- Mapping and Batch Upsert ---------------------
function mapBooking(item, propertiesMap = PROPERTIES_MAP, notesMap = new Map()) {
  const guest = item.guest || {};
  const breakdown = item.total_guest_breakdown || (item.rooms && item.rooms[0]?.guest_breakdown) || {};
  const people = [
    breakdown.adults ? `${breakdown.adults} adult${breakdown.adults > 1 ? "s" : ""}` : "",
    breakdown.children ? `${breakdown.children} child${breakdown.children > 1 ? "ren" : ""}` : "",
    breakdown.infants ? `${breakdown.infants} infant${breakdown.infants > 1 ? "s" : ""}` : ""
  ].filter(Boolean).join(", ") || (item.people ? `${item.people} adult${item.people > 1 ? "s" : ""}` : "");

  const guestPhone = guest.phone || "";
  const rawLockbox = String(guestPhone).replace(/[^0-9]/g, '');
  const lockboxFromPhone = rawLockbox.slice(-4) || "";
  const lockbox = (item.rooms && item.rooms[0]?.key_code) || lockboxFromPhone || "";

  const propName = propertiesMap[item.property_id] || item.property_name || `Property #${item.property_id}`;
  const guestName = guest.name || (item.type === "ClosedPeriod" ? "Closed" : "");

  const bookingId = String(item.id).replace('.0', '');
  const note = (notesMap && notesMap.get(bookingId)) || (item.notes ? cleanNote(item.notes) : (item.note ? cleanNote(item.note) : ""));

  return {
    booking_id: bookingId,
    property_name: propName,
    people,
    guest_name: guestName,
    guest_phone: guestPhone,
    lockbox_code: lockbox,
    check_in_date: item.arrival ? item.arrival.slice(0, 10) : "",
    check_in_time: item.check_in?.time || "16:00:00",
    departure: item.departure ? item.departure.slice(0, 10) : "",
    check_out_time: item.check_out?.time || "11:00:00",
    note,
    detail_status: "DONE"
  };
}

// --- Új foglalási értesítések küldése (Golf del Sur & La Arena) ---
const GOLF_DEL_SUR_NOTIFICATION_EMAIL = "Lymo.canari@gmail.com";

function isGolfDelSurProperty(propName) {
  if (!propName) return false;
  const p = propName.trim().toLowerCase();
  return p.includes("albatros") || p.includes("colibri") || p.includes("tucan");
}

function isLaArenaProperty(propName) {
  if (!propName) return false;
  const p = propName.trim().toLowerCase();
  return p.includes("banana") || p.includes("pirate");
}

async function getUnnotifiedBookings(env, rows) {
  if (!rows || !rows.length || !env.DB) return { unnotifiedBookings: [] };
  try {
    const relevantRows = rows.filter(r => 
      (isGolfDelSurProperty(r.property_name) || isLaArenaProperty(r.property_name)) &&
      r.guest_name &&
      r.guest_name.trim().toLowerCase() !== "closed"
    ).map(r => ({
      ...r,
      area: isGolfDelSurProperty(r.property_name) ? "golf_del_sur" : "la_arena"
    }));

    if (!relevantRows.length) return { unnotifiedBookings: [] };

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS email_notifications (
        booking_id TEXT PRIMARY KEY,
        property_name TEXT,
        guest_name TEXT,
        check_in_date TEXT,
        departure TEXT,
        sent_at TEXT,
        recipient TEXT,
        status TEXT
      )
    `).run();

    const notifiedResult = await env.DB.prepare(
      "SELECT booking_id FROM email_notifications"
    ).all();
    const notifiedSet = new Set((notifiedResult.results || []).map(r => String(r.booking_id).replace('.0', '')));

    const unnotifiedBookings = relevantRows.filter(r => {
      const id = String(r.booking_id).replace('.0', '');
      return !notifiedSet.has(id);
    });

    return { unnotifiedBookings };
  } catch (err) {
    console.error("getUnnotifiedBookings error:", err);
    return { unnotifiedBookings: [] };
  }
}

async function sendNewBookingWhatsAppNotifications(env, unnotifiedBookings) {
  if (!unnotifiedBookings || !unnotifiedBookings.length) return;

  for (const b of unnotifiedBookings) {
    const bId = String(b.booking_id).replace('.0', '');
    const isGolf = isGolfDelSurProperty(b.property_name);
    const isArena = isLaArenaProperty(b.property_name);
    if (!isGolf && !isArena) continue;

    const areaName = isArena ? "La Arena" : "Golf del Sur";
    const recipients = [FERI_WHATSAPP];
    if (isGolf) recipients.push(GOLF_DEL_SUR_CLEANER_WHATSAPP);
    if (isArena) recipients.push(LA_ARENA_CLEANER_WHATSAPP);

    const checkInFormatted = `${b.check_in_date || ''} (${b.check_in_time ? b.check_in_time.slice(0, 5) : '16:00'})`;
    const checkOutFormatted = `${b.departure || ''} (${b.check_out_time ? b.check_out_time.slice(0, 5) : '11:00'})`;

    const waMessageLines = [
      `🏨 *NUEVA RESERVA / ÚJ FOGLALÁS (${areaName})*`,
      ``,
      `📍 *Apartamento / Apartman:* ${b.property_name}`,
      `👤 *Huésped / Vendég:* ${b.guest_name || 'N/A'}`,
      `👥 *Personas / Létszám:* ${b.people || 'N/A'}`,
      `📅 *Llegada / Érkezés:* ${checkInFormatted}`,
      `📅 *Salida / Távozás:* ${checkOutFormatted}`,
      `📞 *Teléfono:* ${b.guest_phone || 'N/A'}`,
      `🔑 *Lockbox / Széf:* ${b.lockbox_code || '-'}`,
      `📝 *Notas / Megjegyzés:* ${b.note || 'Nincs / Ninguna'}`,
      ``,
      `🆔 *ID:* #${bId}`
    ];
    const waMessage = waMessageLines.join("\n");

    for (const r of recipients) {
      try {
        await fetch(`${GREEN_API_URL}/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: r,
            message: waMessage
          })
        });
      } catch (err) {
        console.error("WhatsApp notification error:", err);
      }
    }

    try {
      await env.DB.prepare(`
        INSERT INTO email_notifications (booking_id, property_name, guest_name, check_in_date, departure, sent_at, recipient, status)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?, 'sent')
        ON CONFLICT(booking_id) DO UPDATE SET sent_at = excluded.sent_at, status = 'sent'
      `).bind(
        bId,
        b.property_name || '',
        b.guest_name || '',
        b.check_in_date || '',
        b.departure || '',
        recipients.join(",")
      ).run();
      await logIssue(env, `💬 WhatsApp értesítő elküldve új foglalásról: #${bId} (${b.property_name}) -> ${recipients.join(", ")}`);
    } catch (dbErr) {
      console.error("DB mark notification error:", dbErr);
    }
  }
}

async function batchUpsertBookings(env, rows) {
  if (!rows.length) return;

  const sql = `
    INSERT INTO bookings (
      booking_id, property_name, people, guest_name, guest_phone,
      lockbox_code, check_in_date, check_in_time, departure, check_out_time, note, detail_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(booking_id) 
    DO UPDATE SET
      property_name = excluded.property_name,
      people = excluded.people,
      guest_name = excluded.guest_name,
      guest_phone = excluded.guest_phone,
      lockbox_code = CASE WHEN excluded.lockbox_code != '' THEN excluded.lockbox_code ELSE bookings.lockbox_code END,
      check_in_date = excluded.check_in_date,
      check_in_time = CASE WHEN excluded.check_in_time != '' THEN excluded.check_in_time ELSE bookings.check_in_time END,
      departure = excluded.departure,
      check_out_time = CASE WHEN excluded.check_out_time != '' THEN excluded.check_out_time ELSE bookings.check_out_time END,
      note = CASE WHEN excluded.note != '' THEN excluded.note ELSE bookings.note END,
      detail_status = 'DONE'
  `;

  const BATCH_SIZE = 25;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const statements = chunk.map(r => env.DB.prepare(sql).bind(
      String(r.booking_id).replace('.0', ''),
      r.property_name || '',
      r.people || '',
      r.guest_name || '',
      r.guest_phone || '',
      r.lockbox_code || '',
      r.check_in_date || '',
      r.check_in_time || '16:00:00',
      r.departure || '',
      r.check_out_time || '11:00:00',
      r.note || '',
      r.detail_status || 'DONE'
    ));
    await env.DB.batch(statements);
  }
}

async function pruneStaleBookings(env, validIds, periodStart) {
  if (!validIds || !validIds.length) return [];
  try {
    const existing = await env.DB.prepare(
      "SELECT * FROM bookings WHERE departure >= ?"
    ).bind(periodStart).all();

    const validSet = new Set(validIds.map(id => String(id).replace('.0', '')));
    const bookingsToDelete = (existing.results || [])
      .filter(r => !validSet.has(String(r.booking_id).replace('.0', '')));

    if (bookingsToDelete.length > 0) {
      const BATCH_SIZE = 25;
      for (let i = 0; i < bookingsToDelete.length; i += BATCH_SIZE) {
        const chunk = bookingsToDelete.slice(i, i + BATCH_SIZE);
        const statements = chunk.map(b =>
          env.DB.prepare("DELETE FROM bookings WHERE booking_id = ?").bind(String(b.booking_id).replace('.0', ''))
        );
        await env.DB.batch(statements);
      }
      await logIssue(env, `🧹 Törölve ${bookingsToDelete.length} lemondott/stale foglalás.`);

      // WhatsApp értesítések küldése a törölt foglalásokról
      await sendCancelledBookingWhatsAppNotifications(env, bookingsToDelete);
    }
    return bookingsToDelete;
  } catch (err) {
    console.error("Prune error:", err);
    return [];
  }
}

async function sendCancelledBookingWhatsAppNotifications(env, cancelledBookings) {
  if (!cancelledBookings || !cancelledBookings.length) return;

  const todayIso = new Date().toISOString().slice(0, 10);

  for (const b of cancelledBookings) {
    const bId = String(b.booking_id).replace('.0', '');
    // Csak a mai napon vagy a jövőben távozó/érkező lemondott foglalásokról küldünk értesítést
    if (b.departure && b.departure < todayIso) continue;

    const isGolf = isGolfDelSurProperty(b.property_name);
    const isArena = isLaArenaProperty(b.property_name);
    if (!isGolf && !isArena) continue;

    const areaName = isArena ? "La Arena" : "Golf del Sur";
    const recipients = [FERI_WHATSAPP];
    if (isGolf) recipients.push(GOLF_DEL_SUR_CLEANER_WHATSAPP);
    if (isArena) recipients.push(LA_ARENA_CLEANER_WHATSAPP);

    const checkInFormatted = `${b.check_in_date || ''} (${b.check_in_time ? b.check_in_time.slice(0, 5) : '16:00'})`;
    const checkOutFormatted = `${b.departure || ''} (${b.check_out_time ? b.check_out_time.slice(0, 5) : '11:00'})`;

    const waMessageLines = [
      `❌ *FOGLALÁS LEMONDVA / CANCELACIÓN (${areaName})*`,
      ``,
      `📍 *Apartamento / Apartman:* ${b.property_name}`,
      `👤 *Huésped / Vendég:* ${b.guest_name || 'N/A'}`,
      `👥 *Personas / Létszám:* ${b.people || 'N/A'}`,
      `📅 *Llegada / Tervezett érkezés:* ${checkInFormatted}`,
      `📅 *Salida / Tervezett távozás:* ${checkOutFormatted}`,
      `🆔 *ID:* #${bId}`,
      ``,
      `⚠️ *A foglalás törölve a naptárból. Erre az időszakra nem szükséges takarítani!*`
    ];
    const waMessage = waMessageLines.join("\n");

    for (const r of recipients) {
      try {
        await fetch(`${GREEN_API_URL}/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: r,
            message: waMessage
          })
        });
      } catch (err) {
        console.error("WhatsApp cancellation notification error:", err);
      }
    }

    await logIssue(env, `❌ WhatsApp lemondás értesítő elküldve: #${bId} (${b.property_name}, ${b.guest_name}) -> ${recipients.join(", ")}`);
  }
}

function cleanNote(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>?/gm, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --------------------- serveIcalFeed ---------------------
async function serveIcalFeed(env, properties, settingName, host) {
  let whereClause = "";
  let bindParams = [];
  if (properties.length) {
    whereClause = `WHERE property_name IN (${properties.map((_, i) => `?${i + 1}`).join(",")})`;
    bindParams = properties;
  }
  const sql = `SELECT * FROM bookings ${whereClause} ORDER BY check_in_date ASC`;
  const rowsResult = await env.DB.prepare(sql).bind(...bindParams).all();
  const bookings = rowsResult.results || [];

  let visibleColumns = [];
  const settingsResult = await env.DB.prepare("SELECT value FROM settings WHERE name = ?").bind(settingName).first();

  const allColumns = [
    "booking_id", "property_name", "people", "guest_name", "guest_phone",
    "lockbox_code", "check_in_date", "check_in_time", "departure", "check_out_time", "note", "detail_status"
  ];

  if (settingsResult && settingsResult.value) {
    try {
      const parsed = JSON.parse(settingsResult.value);
      if (Array.isArray(parsed)) {
        visibleColumns = parsed.filter(col => allColumns.includes(col));
      }
    } catch (e) {
      visibleColumns = allColumns;
    }
  } else {
    visibleColumns = allColumns;
  }

  const detailColumns = allColumns.filter(col => visibleColumns.includes(col));

  let ical = `BEGIN:VCALENDAR\r\n`;
  ical += `PRODID:-//Cloudflare Worker//Booking Scheduler v2.0//EN\r\n`;
  ical += `VERSION:2.0\r\n`;
  ical += `CALSCALE:GREGORIAN\r\n`;
  ical += `METHOD:PUBLISH\r\n`;
  ical += `X-WR-CALNAME:${settingName.replace("-Columns", "").replace("-", " ")} Bookings\r\n`;
  ical += `X-PUBLISHED-TTL:PT5M\r\n`;

  for (const booking of bookings) {
    const dtstart = booking.check_in_date ? booking.check_in_date.replace(/-/g, '') : '';
    const dtend = booking.departure ? booking.departure.replace(/-/g, '') : '';
    if (!dtstart || !dtend) continue;

    let summaryParts = [];
    if (visibleColumns.includes('property_name')) summaryParts.push(booking.property_name);
    if (visibleColumns.includes('guest_name') && booking.guest_name) summaryParts.push(booking.guest_name);
    else if (visibleColumns.includes('people') && booking.people) summaryParts.push(booking.people);

    let summary = summaryParts.filter(Boolean).join(' - ') || 'Foglalt';

    const descriptionLines = [];
    const labelMap = {
      "booking_id": "Booking ID",
      "property_name": "Property",
      "people": "People",
      "guest_name": "Guest Name",
      "guest_phone": "Phone",
      "lockbox_code": "Lockbox",
      "check_in_date": "Check-in Date",
      "check_in_time": "Check-in Time",
      "departure": "Departure Date",
      "check_out_time": "Check-out Time",
      "note": "Note",
      "detail_status": "Status"
    };

    for (const col of detailColumns) {
      const label = labelMap[col] || col.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      let value = booking[col] || "Nincs adat";

      if (col !== 'property_name' && col !== 'guest_name' && col !== 'people') {
        if (col === 'check_in_date' || col === 'departure') {
          value = value.slice(0, 10);
        }
        if (col === 'note') {
          value = value.replace(/(\r\n|\n|\r)/gm, '\\n');
        }
        descriptionLines.push(`${label}: ${value}`);
      }
    }

    const description = descriptionLines.join('\\n');

    ical += `BEGIN:VEVENT\r\n`;
    ical += `DTSTART;VALUE=DATE:${dtstart}\r\n`;
    ical += `DTEND;VALUE=DATE:${dtend}\r\n`;
    ical += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z\r\n`;
    ical += `UID:${booking.booking_id}@${host}\r\n`;
    ical += `SUMMARY:${summary}\r\n`;
    ical += `DESCRIPTION:${description.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')}\r\n`;
    ical += `END:VEVENT\r\n`;
  }

  ical += `END:VCALENDAR\r\n`;

  return new Response(ical, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=300"
    },
  });
}

// --------------------- serveTable ---------------------
async function serveTable(env, properties, title, authUser = null, host = "ferkomes.com") {
  let whereClause = "";
  let bindParams = [];
  if (properties && properties.length) {
    whereClause = `WHERE property_name IN (${properties.map((_, i) => `?${i + 1}`).join(",")})`;
    bindParams = properties;
  }
  const sql = `SELECT * FROM bookings ${whereClause} ORDER BY check_in_date ASC`;
  const rowsResult = await env.DB.prepare(sql).bind(...bindParams).all();
  const rawBookings = rowsResult.results || [];

  const isAdmin = authUser && authUser.role === "admin";
  const userRole = authUser ? authUser.role : "guest";

  const cooldownCheck = await checkSyncCooldown(env);
  let lastSyncText = "";
  if (cooldownCheck.lastSyncIso) {
    const d = new Date(cooldownCheck.lastSyncIso);
    lastSyncText = d.toLocaleTimeString("hu-HU", { timeZone: "Europe/Madrid", hour: '2-digit', minute: '2-digit' });
  }

  let defaultArea = "all";
  if (properties && properties.length === 2) {
    defaultArea = "arena";
  } else if (properties && properties.length === 3) {
    defaultArea = "golf";
  }

  let html = `<!DOCTYPE html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} - Takarítási Naptár</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  box-sizing: border-box;
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  --bg: #f4f6f3;
  --panel: #ffffff;
  --ink: #16231f;
  --mute: #5b6b65;
  --line: #dbe4df;
  --out: #b8410a;
  --outbg: #fdebdd;
  --in: #0b6b5e;
  --inbg: #dcf3ec;
  --warn: #7a4b00;
  --warnbg: #fff0c2;
  --ok: #0b6b5e;
  --focus: #2563eb;
  --turnover-badge: #dc2626;
  --turnover-bg: #fee2e2;
  --radius: 12px;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0e1714;
    --panel: #16231f;
    --ink: #e8f0ec;
    --mute: #9bb0a8;
    --line: #27382f;
    --out: #ffa66b;
    --outbg: #3a2415;
    --in: #6fe0c8;
    --inbg: #12342d;
    --warn: #ffd773;
    --warnbg: #3a3010;
    --ok: #6fe0c8;
    --focus: #8fb3ff;
    --turnover-badge: #f87171;
    --turnover-bg: #450a0a;
  }
}

:root[data-theme="dark"] {
  --bg: #0e1714;
  --panel: #16231f;
  --ink: #e8f0ec;
  --mute: #9bb0a8;
  --line: #27382f;
  --out: #ffa66b;
  --outbg: #3a2415;
  --in: #6fe0c8;
  --inbg: #12342d;
  --warn: #ffd773;
  --warnbg: #3a3010;
  --ok: #6fe0c8;
  --focus: #8fb3ff;
  --turnover-badge: #f87171;
  --turnover-bg: #450a0a;
}

*, *::before, *::after { box-sizing: inherit; }
html { scroll-padding-top: env(safe-area-inset-top, 0px); height: 100%; }
body {
  margin: 0;
  min-height: 100%;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.45 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: "";
  position: fixed;
  inset: 0 0 auto;
  height: env(safe-area-inset-top, 0px);
  background: var(--bg);
  z-index: 10;
}

h1, h2, h3, .time, .apt, .sum b, .seg button, .code, .timeline-apt-name, .nav-date-title {
  font-family: "Bricolage Grotesque", system-ui, sans-serif;
}

main {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px 16px 60px;
}

header {
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  background: var(--bg);
  z-index: 20;
  padding: 6px 0 14px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 16px;
}

.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}

h1 {
  font-size: 24px;
  line-height: 1.1;
  margin: 0;
  font-weight: 800;
  letter-spacing: -0.5px;
}

.sub {
  color: var(--mute);
  margin: 0;
  font-size: 13px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sync-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--panel);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 12px;
  font: 600 13px 'Plus Jakarta Sans', sans-serif;
  cursor: pointer;
  transition: all 0.2s ease;
}
.sync-btn:hover { background: var(--line); }
.sync-btn:disabled { opacity: 0.6; cursor: not-allowed; }

.user-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
  color: var(--mute);
  cursor: pointer;
}
.user-badge:hover { background: var(--line); color: var(--ink); }

/* KPI Summary Cards */
.sum {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.sum div {
  flex: 1 1 130px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 14px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.03);
}
.sum b {
  display: block;
  font: 800 24px/1 "Bricolage Grotesque", sans-serif;
}
.sum span {
  color: var(--mute);
  font-size: 13px;
  font-weight: 500;
}
.sum .hot b { color: var(--out); }

/* Controls */
.tools {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tools-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.tools input {
  flex: 1 1 200px;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--ink);
  font: inherit;
  font-size: 14px;
}
.tools input:focus {
  outline: none;
  border-color: var(--focus);
}

.seg {
  display: flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
}
.seg button {
  border: 0;
  background: none;
  color: var(--mute);
  padding: 8px 12px;
  font: 600 13px "Bricolage Grotesque", sans-serif;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.seg button[aria-pressed="true"] {
  background: var(--ink);
  color: var(--bg);
  font-weight: 700;
}

/* NAPI LISTA NÉZET */
.day {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 6px 16px;
  margin-top: 24px;
}
.day > h2 {
  font-size: 18px;
  margin: 0;
  padding-top: 8px;
  line-height: 1.2;
}
.day > h2 small {
  display: block;
  font: 500 13px 'Plus Jakarta Sans', sans-serif;
  color: var(--mute);
}
.day.today > h2 { color: var(--out); }

.list {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,0.03);
}

.row {
  display: grid;
  grid-template-columns: 6px 80px 1fr auto;
  gap: 0 14px;
  align-items: center;
  padding: 12px 14px 12px 0;
  border-top: 1px solid var(--line);
  transition: background 0.15s;
}
.row:first-child { border-top: 0; }
.row:hover { background: rgba(0,0,0,0.015); }
.bar { align-self: stretch; }

.time {
  font-size: 22px;
  font-weight: 800;
  color: var(--ink);
  letter-spacing: -0.5px;
}

.badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 99px;
  margin-bottom: 2px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.out .badge { background: var(--outbg); color: var(--out); }
.in .badge { background: var(--inbg); color: var(--in); }

.turnover-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--turnover-bg);
  color: var(--turnover-badge);
  font-size: 11px;
  font-weight: 800;
  padding: 2px 7px;
  border-radius: 99px;
  margin-left: 6px;
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.apt {
  font-size: 18px;
  font-weight: 800;
  line-height: 1.2;
}
.who {
  color: var(--mute);
  font-size: 14px;
}

.note {
  display: inline-block;
  margin-top: 6px;
  background: var(--warnbg);
  color: var(--warn);
  font-weight: 700;
  font-size: 13px;
  padding: 3px 9px;
  border-radius: 6px;
}

.act {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
}
.code {
  font: 700 16px ui-monospace, Menlo, Consolas, monospace;
  letter-spacing: .12em;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--ink);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  transition: all 0.15s;
}
.code:hover { background: var(--line); }

.chk {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  min-height: 30px;
  user-select: none;
}
.chk input {
  width: 20px;
  height: 20px;
  accent-color: var(--ok);
  cursor: pointer;
}

.row.done .apt, .row.done .who {
  text-decoration: line-through;
  opacity: .5;
}
.row.done {
  background: rgba(11, 107, 94, 0.04);
}

/* FOLYAMATOS SÁVOS NAPTÁR (TIMELINE) */
.timeline-section {
  display: none;
  margin-top: 16px;
}

.timeline-nav-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px 16px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.02);
}
.nav-date-title {
  font-size: 18px;
  font-weight: 800;
  color: var(--ink);
  display: flex;
  align-items: center;
  gap: 8px;
}
.nav-buttons {
  display: flex;
  gap: 6px;
  align-items: center;
}
.nav-btn {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  padding: 6px 12px;
  font: 700 13px "Bricolage Grotesque", sans-serif;
  cursor: pointer;
  transition: all 0.15s;
}
.nav-btn:hover { background: var(--line); }
.nav-btn-today {
  background: var(--ink);
  color: var(--bg);
  border-color: var(--ink);
}

.timeline-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,0.03);
  margin-bottom: 22px;
}
.timeline-header {
  padding: 12px 16px;
  background: rgba(0,0,0,0.02);
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.timeline-header h3 {
  font-size: 17px;
  font-weight: 800;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.timeline-header span {
  font-size: 12px;
  color: var(--mute);
  font-weight: 600;
}

.timeline-scroll-wrap {
  overflow-x: auto;
  padding: 14px 12px 18px;
  -webkit-overflow-scrolling: touch;
}

.timeline-matrix {
  display: grid;
  position: relative;
  width: max-content;
  min-width: 100%;
}

.matrix-header-row {
  display: grid;
  gap: 4px;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--line);
  margin-bottom: 12px;
}
.matrix-day-cell {
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--ink);
  min-width: 48px;
}
.matrix-day-cell small {
  display: block;
  font-size: 10px;
  color: var(--mute);
  font-weight: 500;
}
.matrix-day-cell.today {
  color: var(--out);
  font-weight: 800;
}
.matrix-day-cell.today small {
  color: var(--out);
  font-weight: 700;
}

.matrix-apt-row {
  display: grid;
  gap: 4px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
  position: relative;
  min-height: 56px;
}
.matrix-apt-row:last-child { border-bottom: none; }

.span-btn {
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  padding: 5px 9px;
  border-radius: 8px;
  font-weight: 700;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.span-btn[aria-pressed="true"] {
  background: var(--ink);
  color: var(--bg);
}

.matrix-apt-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 6px;
  z-index: 2;
}
.matrix-apt-title .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.matrix-apt-title .name {
  font-size: 14px;
  font-weight: 800;
  white-space: nowrap;
}

.matrix-bg-slot {
  height: 44px;
  background: var(--bg);
  border-radius: 6px;
  border: 1px dashed var(--line);
  opacity: 0.6;
}
.matrix-bg-slot.is-today {
  border: 1px solid #fca5a5;
  background: #fef2f2;
}

/* FOLYAMATOS SÁVOK */
.booking-span-bar {
  grid-row: 1;
  height: 38px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  color: white;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 2px 4px rgba(0,0,0,0.12);
  cursor: pointer;
  z-index: 5;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  position: relative;
}
.booking-span-bar:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0,0,0,0.18);
  filter: brightness(1.05);
}

.booking-span-bar .bar-title {
  font-family: "Bricolage Grotesque", sans-serif;
  font-size: 13px;
  font-weight: 700;
  margin-right: 6px;
}
.booking-span-bar .bar-info {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.9;
}
.booking-span-bar .bar-note {
  background: rgba(0,0,0,0.25);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  margin-left: 6px;
  font-weight: 700;
}

.bar-turnover-edge {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 24px;
  background: repeating-linear-gradient(
    45deg,
    rgba(220, 38, 38, 0.8),
    rgba(220, 38, 38, 0.8) 4px,
    rgba(255, 255, 255, 0.3) 4px,
    rgba(255, 255, 255, 0.3) 8px
  );
  border-radius: 0 8px 8px 0;
}

/* Toast Message */
.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%) translateY(100px);
  background: #16231f;
  color: #ffffff;
  padding: 12px 20px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
  box-shadow: 0 10px 25px rgba(0,0,0,0.2);
  opacity: 0;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 9999;
  max-width: 90%;
  text-align: center;
}
.toast.show {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}

/* Modal Popup */
.modal-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  backdrop-filter: blur(2px);
  z-index: 1000;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.modal-box {
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  padding: 20px;
  max-width: 380px;
  width: 100%;
  box-shadow: 0 20px 30px rgba(0,0,0,0.25);
  color: var(--ink);
  animation: popIn 0.2s ease-out;
}
@keyframes popIn {
  from { transform: scale(0.95); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.modal-box h4 {
  font-family: "Bricolage Grotesque", sans-serif;
  font-size: 19px;
  margin: 0 0 4px;
  font-weight: 800;
}

@media (max-width: 640px) {
  .day { grid-template-columns: 1fr; }
  .day > h2 { padding-top: 0; display: flex; gap: 8px; align-items: baseline; }
  .row { grid-template-columns: 5px 1fr auto; gap: 0 10px; }
  .time { grid-column: 2; font-size: 18px; }
  .row > .mid { grid-column: 2; }
  .row > .act { grid-column: 3; grid-row: 1/3; }
  .code { font-size: 15px; padding: 4px 8px; }
  .sum div { flex: 1 1 110px; padding: 8px 10px; }
  .sum b { font-size: 20px; }
}
</style>
</head>
<body>

<main>
  <header>
    <div class="top-bar">
      <div>
        <h1>${title}</h1>
        <p class="sub">Takarítási Naptár ${lastSyncText ? `• Frissítve: ${lastSyncText}` : ''}</p>
      </div>
      <div class="header-actions">
        ${isAdmin ? `
        <button class="sync-btn" id="syncBtn" onclick="triggerSync()">
          <span id="syncIcon">🔄</span> <span id="syncText">Frissítés</span>
        </button>
        ` : ''}
        ${authUser ? `
        <div class="user-badge" onclick="logout()" title="Kijelentkezés">
          <span>👤 <strong>${authUser.username}</strong></span>
          <span style="font-size:10px; background:var(--line); padding:2px 6px; border-radius:4px;">Kilépés</span>
        </div>
        ` : ''}
      </div>
    </div>

    ${isAdmin ? `
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
      <button type="button" onclick="location.href='?view=all'" class="nav-btn ${title === 'All Bookings' ? 'nav-btn-today' : ''}">Összes apartman</button>
      <button type="button" onclick="location.href='?view=la-arena'" class="nav-btn ${title.includes('La-Arena') ? 'nav-btn-today' : ''}">La-Arena (Kata)</button>
      <button type="button" onclick="location.href='?view=golf-del-sur'" class="nav-btn ${title.includes('Golf-del-Sur') ? 'nav-btn-today' : ''}">Golf-del-Sur (Gábor)</button>
      <button type="button" onclick="location.href='?view=logs'" class="nav-btn">Rendszernaplók</button>
      <button type="button" onclick="openIcalModal()" class="nav-btn" style="color:var(--focus);">📅 iCal Linkek</button>
    </div>
    ` : ''}

    <!-- KPI SUMMARIES -->
    <div class="sum" id="sum">
      <div class="hot">
        <b id="kpiToday">0</b>
        <span>takarítás vár ma</span>
      </div>
      <div>
        <b id="kpiWeek">0</b>
        <span>feladat 7 napon belül</span>
      </div>
      <div>
        <b id="kpiNotes">0</b>
        <span>különleges kérés (kiságy)</span>
      </div>
    </div>

    <!-- CONTROLS -->
    <div class="tools">
      <div class="tools-row">
        <input id="q" type="search" placeholder="Keresés apartmanra, vendégre, kódra, babaágyra…" aria-label="Keresés">
        
        <!-- Nézet váltó (Lista vs Naptár) -->
        <div class="seg" role="group" aria-label="Nézet">
          <button id="viewListBtn" aria-pressed="true" onclick="switchView('list')">📋 Lista</button>
          <button id="viewTimelineBtn" aria-pressed="false" onclick="switchView('timeline')">📆 Naptár (3 / 2 sor)</button>
        </div>
      </div>

      <div class="tools-row" style="justify-content:space-between;">
        <!-- Terület választó (csak ha Admin nézi az összeset) -->
        ${!properties || !properties.length ? `
        <div class="seg" id="areaFilterContainer" role="group" aria-label="Terület">
          <button class="area-btn" data-a="all" aria-pressed="true" onclick="filterArea('all')">Összes</button>
          <button class="area-btn" data-a="golf" aria-pressed="false" onclick="filterArea('golf')">⛳ Golf del Sur</button>
          <button class="area-btn" data-a="arena" aria-pressed="false" onclick="filterArea('arena')">🏖️ La Arena</button>
        </div>
        ` : ''}

        <!-- Művelet szűrő (csak lista nézetben látszik) -->
        <div class="seg" id="typeFilters" role="group" aria-label="Szűrés">
          <button class="type-btn" data-f="all" aria-pressed="true" onclick="filterType('all')">Mind</button>
          <button class="type-btn" data-f="out" aria-pressed="false" onclick="filterType('out')">Takarítás (11h)</button>
          <button class="type-btn" data-f="in" aria-pressed="false" onclick="filterType('in')">Érkezés (16h)</button>
        </div>
      </div>
    </div>
  </header>

  <!-- 1. NAPI LISTA NÉZET -->
  <div id="listView"></div>

  <!-- 2. FOLYAMATOS SÁVOS NAPTÁR NÉZET (3 ÉS 2 SOR) -->
  <div id="timelineView" class="timeline-section">

    <div class="timeline-nav-bar">
      <div class="nav-date-title">
        <span>📅</span> <span id="rangeLabel">1 hónapos folyamatos naptár</span>
      </div>
      <div class="nav-buttons">
        <div class="seg" role="group" aria-label="Időtartam" style="display:inline-flex; margin-right:4px;">
          <button id="span14Btn" class="span-btn" onclick="changeTimelineSpan(14)">14 nap</button>
          <button id="span30Btn" class="span-btn" aria-pressed="true" onclick="changeTimelineSpan(30)">1 hónap</button>
        </div>
        <button class="nav-btn" onclick="navigateDays(-30)" title="Vissza 1 hónapot">◀ 1 hó</button>
        <button class="nav-btn" onclick="navigateDays(-7)" title="Vissza 7 napot">◀ 7 nap</button>
        <button class="nav-btn nav-btn-today" onclick="navigateToday()" title="Ugrás a mai napra">Ma</button>
        <button class="nav-btn" onclick="navigateDays(7)" title="Előre 7 napot">+7 nap ▶</button>
        <button class="nav-btn" onclick="navigateDays(30)" title="Előre 1 hónapot">+1 hó ▶</button>
      </div>
    </div>

    <!-- GOLF DEL SUR (3 SOR) -->
    <div class="timeline-card" id="golfTimelineCard">
      <div class="timeline-header">
        <h3>⛳ Golf del Sur <span>(3 soros idővonal)</span></h3>
        <span>The Albatros, The Colibri, The Tucan</span>
      </div>
      <div class="timeline-scroll-wrap">
        <div class="timeline-matrix" id="golfMatrix"></div>
      </div>
    </div>

    <!-- LA ARENA (2 SOR) -->
    <div class="timeline-card" id="arenaTimelineCard">
      <div class="timeline-header">
        <h3>🏖️ La Arena <span>(2 soros idővonal)</span></h3>
        <span>The Banana, The Pirate</span>
      </div>
      <div class="timeline-scroll-wrap">
        <div class="timeline-matrix" id="arenaMatrix"></div>
      </div>
    </div>

  </div>

</main>

<!-- MODAL POPUP (FOGLALÁSI RÉSZLETEKHEZ) -->
<div class="modal-overlay" id="bookingModal" onclick="closeModal(event)">
  <div class="modal-box" onclick="event.stopPropagation()">
    <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px;">
      <h4 id="mPropName">Apartman</h4>
      <span id="mDateSpan" style="font-size:12px; font-weight:700; color:var(--mute);">Dátumok</span>
    </div>
    <div style="font-size:15px; font-weight:700; margin-bottom:4px;" id="mGuestName">Vendég</div>
    <div style="font-size:13px; color:var(--mute); margin-bottom:12px;" id="mGuestPeople">Létszám</div>

    <div style="background:var(--bg); padding:10px 12px; border-radius:8px; border:1px solid var(--line); margin-bottom:12px; font-size:13px;">
      <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
        <span>🚪 Check-Out:</span> <strong id="mCheckout">11:00</strong>
      </div>
      <div style="display:flex; justify-content:space-between;">
        <span>🧳 Check-In:</span> <strong id="mCheckin">16:00</strong>
      </div>
    </div>

    <div id="mNoteBox" style="display:none; background:var(--warnbg); color:var(--warn); padding:8px 10px; border-radius:8px; font-size:13px; font-weight:700; margin-bottom:12px;">
      👶 <span id="mNoteText">Megjegyzés</span>
    </div>

    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px; border-top:1px solid var(--line); padding-top:12px;">
      <div style="display:flex; align-items:center; gap:6px;">
        <span style="font-size:13px; font-weight:700;">Széf:</span>
        <button class="code" id="mCodeBtn" onclick="copyModalCode()">-</button>
      </div>
      <button class="nav-btn" onclick="document.getElementById('bookingModal').style.display='none'">Bezárás</button>
    </div>
  </div>
</div>

<!-- ICAL MODAL (ADMIN) -->
<div class="modal-overlay" id="icalModal" onclick="this.style.display='none'">
  <div class="modal-box" onclick="event.stopPropagation()" style="max-width:440px;">
    <h4 style="margin-bottom:12px;">📅 iCal Naptár Linkek</h4>
    <p style="font-size:13px; color:var(--mute); margin-bottom:12px;">Másold be a linket Google Naptárba vagy Apple Calendarba az automatikus szinkronhoz:</p>
    <div style="margin-bottom:10px;">
      <span style="font-size:12px; font-weight:700;">⛳ Golf del Sur iCal:</span>
      <div class="code" style="font-size:12px; word-break:break-all; margin-top:4px;" onclick="copyDirectText('https://${host}/golf-del-sur-ical')">https://${host}/golf-del-sur-ical</div>
    </div>
    <div style="margin-bottom:14px;">
      <span style="font-size:12px; font-weight:700;">🏖️ La Arena iCal:</span>
      <div class="code" style="font-size:12px; word-break:break-all; margin-top:4px;" onclick="copyDirectText('https://${host}/la-arena-ical')">https://${host}/la-arena-ical</div>
    </div>
    <button class="nav-btn" style="width:100%;" onclick="document.getElementById('icalModal').style.display='none'">Bezárás</button>
  </div>
</div>

<!-- TOAST MESSAGE -->
<div id="toast" class="toast">Kész!</div>

<script>
const RAW_BOOKINGS = ${JSON.stringify(rawBookings)};
const ALLOWED_PROPERTIES = ${JSON.stringify(properties || [])};
const CURRENT_USER = ${JSON.stringify({ username: authUser ? authUser.username : 'Vendég', role: userRole, isAdmin })};
const DEFAULT_AREA = "${defaultArea}";

const BASE_TODAY = new Date();
BASE_TODAY.setHours(0, 0, 0, 0);

let timelineOffsetDays = 0;
let timelineDaysCount = 30; // Alapértelmezés: 1 teljes hónap (30 nap)

const PROPERTIES_CONFIG = {
  golf: [
    { name: 'The Albatros', color: '#4f46e5', icon: '🦅' },
    { name: 'The Colibri', color: '#0284c7', icon: '🐦' },
    { name: 'The Tucan', color: '#16a34a', icon: '🦜' }
  ],
  arena: [
    { name: 'The Banana', color: '#d97706', icon: '🍌' },
    { name: 'The Pirate', color: '#7c3aed', icon: '🏴‍☠️' }
  ]
};

let currentType = 'all';
let currentArea = DEFAULT_AREA;
let currentView = 'list';
let searchQuery = '';

if (ALLOWED_PROPERTIES.length > 0) {
  const areaFilterEl = document.getElementById('areaFilterContainer');
  if (areaFilterEl) areaFilterEl.style.display = 'none';
}

function parseDateToDays(isoStr) {
  if (!isoStr) return 0;
  const d = new Date(isoStr.slice(0, 10));
  d.setHours(0, 0, 0, 0);
  const diffTime = d.getTime() - BASE_TODAY.getTime();
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}

function getDayDate(n) {
  const d = new Date(BASE_TODAY);
  d.setDate(d.getDate() + n);
  return d;
}

const PROCESSED_BOOKINGS = (RAW_BOOKINGS || []).map(b => {
  const startOffset = parseDateToDays(b.check_in_date);
  const endOffset = parseDateToDays(b.departure);
  const pName = b.property_name || '';
  const isArena = pName.includes('Banana') || pName.includes('Pirate');
  const area = isArena ? 'arena' : 'golf';

  return {
    id: String(b.booking_id).replace('.0', ''),
    apt: pName,
    area: area,
    guest: b.guest_name || 'Vendég',
    people: b.people || '',
    phone: b.guest_phone || '',
    lockbox: b.lockbox_code || '-',
    startOffset: startOffset,
    endOffset: endOffset,
    startDateStr: b.check_in_date,
    endDateStr: b.departure,
    checkInTime: b.check_in_time ? b.check_in_time.slice(0, 5) : '16:00',
    checkOutTime: b.check_out_time ? b.check_out_time.slice(0, 5) : '11:00',
    note: b.note || '',
    cleanedStatus: b.cleaned_status || 'pending',
    isTurnoverOut: false,
    isTurnoverIn: false
  };
});

PROCESSED_BOOKINGS.forEach(b1 => {
  const sameDayNext = PROCESSED_BOOKINGS.find(b2 => b2.apt === b1.apt && b2.startOffset === b1.endOffset && b2.id !== b1.id);
  if (sameDayNext) {
    b1.isTurnoverOut = true;
    sameDayNext.isTurnoverIn = true;
  }
});

function renderList() {
  const s = searchQuery.toLowerCase().trim();
  const events = [];

  PROCESSED_BOOKINGS.forEach(b => {
    events.push({
      eventId: b.id + '_out',
      bookingId: b.id,
      d: b.endOffset,
      t: 'out',
      time: b.checkOutTime,
      apt: b.apt,
      area: b.area,
      guest: b.guest,
      people: b.people,
      lockbox: b.lockbox,
      note: b.note,
      turnover: b.isTurnoverOut,
      isCleaned: b.cleanedStatus === 'done'
    });

    events.push({
      eventId: b.id + '_in',
      bookingId: b.id,
      d: b.startOffset,
      t: 'in',
      time: b.checkInTime,
      apt: b.apt,
      area: b.area,
      guest: b.guest,
      people: b.people,
      lockbox: b.lockbox,
      note: b.note,
      turnover: b.isTurnoverIn,
      isCleaned: b.cleanedStatus === 'done'
    });
  });

  const filtered = events.filter(e => {
    const matchType = (currentType === 'all') || (e.t === currentType);
    const matchArea = (currentArea === 'all') || (e.area === currentArea);
    const matchSearch = !s || (e.apt + e.guest + e.lockbox + (e.note || '')).toLowerCase().includes(s);
    const matchRange = e.d >= -1 && e.d <= 60;
    return matchType && matchArea && matchSearch && matchRange;
  });

  const days = [...new Set(filtered.map(e => e.d))].sort((a, b) => a - b);
  const container = document.getElementById('listView');

  if (!days.length) {
    container.innerHTML = '<p style="text-align:center; padding:40px 10px; color:var(--mute);">Nincs megjeleníthető foglalás a kiválasztott szűrőkkel.</p>';
    updateKPIs();
    return;
  }

  container.innerHTML = days.map(n => {
    const dObj = getDayDate(n);
    const dayName = n === 0 ? 'Ma' : n === 1 ? 'Holnap' : n === -1 ? 'Tegnap' : dObj.toLocaleDateString('hu-HU', { weekday: 'long' });
    const fullDate = dObj.toLocaleDateString('hu-HU', { month: 'long', day: 'numeric' });

    let rowsHtml = filtered.filter(e => e.d === n).map(e => {
      const allProps = [...PROPERTIES_CONFIG.golf, ...PROPERTIES_CONFIG.arena];
      const propInfo = allProps.find(p => p.name === e.apt) || { color: '#64748b' };
      return '<div class="row ' + e.t + (e.isCleaned ? ' done' : '') + '">' +
        '<span class="bar" style="background:' + propInfo.color + '"></span>' +
        '<div class="time">' + e.time + '</div>' +
        '<div class="mid">' +
          '<div>' +
            '<span class="badge">' + (e.t === 'out' ? 'Takarítás' : 'Érkezés') + '</span>' +
            (e.turnover ? '<span class="turnover-pill">⚡ Turnover</span>' : '') +
          '</div>' +
          '<div class="apt">' + e.apt + '</div>' +
          '<div class="who">' + e.guest + (e.people ? ', ' + e.people : '') + '</div>' +
          (e.note ? '<div class="note">👶 ' + e.note + '</div>' : '') +
        '</div>' +
        '<div class="act">' +
          '<button class="code" data-k="' + e.lockbox + '" title="Széfkód másolása">' + e.lockbox + '</button>' +
          '<label class="chk">' +
            '<input type="checkbox" data-bid="' + e.bookingId + '" data-apt="' + e.apt + '" ' + (e.isCleaned ? 'checked' : '') + ' onchange="handleCleanToggle(this)">' +
            'Kész' +
          '</label>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<section class="day' + (n === 0 ? ' today' : '') + '">' +
      '<h2>' + dayName + '<small>' + fullDate + '</small></h2>' +
      '<div class="list">' + rowsHtml + '</div>' +
    '</section>';
  }).join('');

  updateKPIs();
}

function updateKPIs() {
  const activeBookings = PROCESSED_BOOKINGS.filter(b => (currentArea === 'all') || (b.area === currentArea));
  const todo = activeBookings.filter(b => b.endOffset === 0 && b.cleanedStatus !== 'done').length;
  const week = activeBookings.filter(b => (b.startOffset >= 0 && b.startOffset <= 6) || (b.endOffset >= 0 && b.endOffset <= 6)).length;
  const notes = activeBookings.filter(b => b.note && ((b.startOffset >= 0 && b.startOffset <= 6) || (b.endOffset >= 0 && b.endOffset <= 6))).length;

  document.getElementById('kpiToday').textContent = todo;
  document.getElementById('kpiWeek').textContent = week;
  document.getElementById('kpiNotes').textContent = notes;
}

function changeTimelineSpan(count) {
  timelineDaysCount = count;
  const b14 = document.getElementById('span14Btn');
  const b30 = document.getElementById('span30Btn');
  if (b14) b14.setAttribute('aria-pressed', count === 14 ? 'true' : 'false');
  if (b30) b30.setAttribute('aria-pressed', count === 30 ? 'true' : 'false');
  renderTimeline();
}

function renderTimeline() {
  const startDay = timelineOffsetDays;
  const count = timelineDaysCount;
  const endDay = startDay + count - 1;

  const sDate = getDayDate(startDay).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' });
  const eDate = getDayDate(endDay).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' });
  const labelSuffix = count === 30 ? '1 hónapos folyamatos naptár' : count + ' napos naptár';
  document.getElementById('rangeLabel').textContent = sDate + ' – ' + eDate + ' (' + labelSuffix + ')';

  renderMatrixForRegion('golf', 'golfMatrix', PROPERTIES_CONFIG.golf, startDay, count);
  renderMatrixForRegion('arena', 'arenaMatrix', PROPERTIES_CONFIG.arena, startDay, count);
}

function renderMatrixForRegion(regionKey, containerId, propertiesList, startDay, count) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const days = [];
  for (let i = 0; i < count; i++) days.push(startDay + i);

  let headerHtml = '<div class="matrix-header-row" style="grid-template-columns: 130px repeat(' + count + ', 50px);"><div style="font-size:12px; font-weight:800; color:var(--mute); padding-left:4px;">Apartman</div>';
  days.forEach(dIdx => {
    const dObj = getDayDate(dIdx);
    const isToday = (dIdx === 0);
    const dayShort = dIdx === 0 ? 'Ma' : dObj.toLocaleDateString('hu-HU', { weekday: 'short' });
    const dateNum = dObj.getDate();
    headerHtml += '<div class="matrix-day-cell' + (isToday ? ' today' : '') + '">' + dayShort + '<small>' + dateNum + '.</small></div>';
  });
  headerHtml += '</div>';

  let rowsHtml = '';
  propertiesList.forEach(prop => {
    const aptBookings = PROCESSED_BOOKINGS.filter(b => b.apt === prop.name);

    rowsHtml += '<div class="matrix-apt-row" style="grid-template-columns: 130px repeat(' + count + ', 50px);">' +
      '<div class="matrix-apt-title">' +
        '<span class="dot" style="background:' + prop.color + ';"></span>' +
        '<span class="name">' + prop.name + '</span>' +
      '</div>';

    days.forEach(dIdx => {
      const isToday = (dIdx === 0);
      rowsHtml += '<div class="matrix-bg-slot' + (isToday ? ' is-today' : '') + '"></div>';
    });

    aptBookings.forEach(b => {
      if (b.endOffset >= startDay && b.startOffset <= (startDay + count - 1)) {
        const colStart = Math.max(1, b.startOffset - startDay + 1) + 1;
        const colEnd = Math.min(count, b.endOffset - startDay + 1) + 2;

        const isStartClipped = b.startOffset < startDay;
        const isEndClipped = b.endOffset > (startDay + count - 1);
        const radiusStyle = 'border-radius: ' + (isStartClipped ? '0' : '8px') + ' ' + (isEndClipped ? '0' : '8px') + ' ' + (isEndClipped ? '0' : '8px') + ' ' + (isStartClipped ? '0' : '8px') + ';';

        rowsHtml += '<div class="booking-span-bar" data-bid="' + b.id + '" style="grid-column: ' + colStart + ' / ' + colEnd + '; background: ' + prop.color + '; ' + radiusStyle + '" onclick="openBookingModal(this.dataset.bid)" title="' + b.guest + ' (' + b.people + ') - Részletekért kattints!">' +
          '<span class="bar-title">' + b.guest + '</span>' +
          '<span class="bar-info">' + (b.people ? '(' + b.people + ')' : '') + '</span>' +
          (b.note ? '<span class="bar-note">👶 Kiságy</span>' : '') +
          (b.isTurnoverOut ? '<span class="bar-turnover-edge" title="Turnover nap! Távozás 11h"></span>' : '') +
        '</div>';
      }
    });

    rowsHtml += '</div>';
  });

  container.innerHTML = headerHtml + rowsHtml;
}

function navigateDays(delta) {
  timelineOffsetDays += delta;
  renderTimeline();
}

function navigateToday() {
  timelineOffsetDays = 0;
  renderTimeline();
  showToast('📅 Visszaugrottunk a mai naphoz!');
}

async function handleCleanToggle(chk) {
  const bId = chk.dataset.bid;
  const apt = chk.dataset.apt;
  const isDone = chk.checked;

  const targetBooking = PROCESSED_BOOKINGS.find(b => b.id === bId);
  if (targetBooking) {
    targetBooking.cleanedStatus = isDone ? 'done' : 'pending';
  }

  renderList();

  try {
    const res = await fetch('?action=toggle-cleaned', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: bId, is_done: isDone })
    });
    const result = await res.json();
    if (result.success) {
      if (isDone) {
        showToast('✨ <strong>Takarítás kész!</strong> (' + apt + ')<br><span style="font-size:11px; opacity:0.85;">💬 WhatsApp üzenet azonnal elküldve Ferencnek!</span>');
      } else {
        showToast('↩️ Visszavonva: ' + apt);
      }
    } else {
      showToast('⚠️ Hiba a mentés során: ' + result.error);
    }
  } catch (err) {
    showToast('⚠️ Hálózati hiba a státusz mentésekor');
  }
}

let currentModalCode = '';
function openBookingModal(bId) {
  const b = PROCESSED_BOOKINGS.find(x => x.id === bId);
  if (!b) return;

  document.getElementById('mPropName').textContent = b.apt;
  document.getElementById('mDateSpan').textContent = b.startDateStr + ' – ' + b.endDateStr;
  document.getElementById('mGuestName').textContent = b.guest;
  document.getElementById('mGuestPeople').textContent = b.people || '-';
  document.getElementById('mCheckout').textContent = b.checkOutTime;
  document.getElementById('mCheckin').textContent = b.checkInTime;
  document.getElementById('mCodeBtn').textContent = b.lockbox;
  currentModalCode = b.lockbox;

  const noteBox = document.getElementById('mNoteBox');
  if (b.note) {
    noteBox.style.display = 'block';
    document.getElementById('mNoteText').textContent = b.note;
  } else {
    noteBox.style.display = 'none';
  }

  document.getElementById('bookingModal').style.display = 'flex';
}

function closeModal(e) {
  document.getElementById('bookingModal').style.display = 'none';
}

function copyModalCode() {
  copyDirectText(currentModalCode);
  const btn = document.getElementById('mCodeBtn');
  btn.textContent = 'Másolva';
  setTimeout(() => { btn.textContent = currentModalCode; }, 1200);
}

function copyDirectText(text) {
  try { navigator.clipboard.writeText(text); } catch (e) {}
  showToast('🔑 Kód (#' + text + ') a vágólapra másolva!');
}

document.addEventListener('click', ev => {
  const b = ev.target.closest('.code:not(#mCodeBtn)');
  if (b) {
    const k = b.dataset.k;
    copyDirectText(k);
    b.textContent = 'Másolva';
    setTimeout(() => { b.textContent = k; }, 1200);
  }
});

function openIcalModal() {
  document.getElementById('icalModal').style.display = 'flex';
}

function switchView(view) {
  currentView = view;
  const listView = document.getElementById('listView');
  const timelineView = document.getElementById('timelineView');
  const typeFilters = document.getElementById('typeFilters');

  const listBtn = document.getElementById('viewListBtn');
  const timelineBtn = document.getElementById('viewTimelineBtn');

  if (view === 'timeline') {
    listView.style.display = 'none';
    timelineView.style.display = 'block';
    typeFilters.style.opacity = '0.35';
    typeFilters.style.pointerEvents = 'none';
    listBtn.setAttribute('aria-pressed', 'false');
    timelineBtn.setAttribute('aria-pressed', 'true');
    renderTimeline();
    applyTimelineAreaFilter();
  } else {
    listView.style.display = 'block';
    timelineView.style.display = 'none';
    typeFilters.style.opacity = '1';
    typeFilters.style.pointerEvents = 'auto';
    listBtn.setAttribute('aria-pressed', 'true');
    timelineBtn.setAttribute('aria-pressed', 'false');
    renderList();
  }
}

function filterArea(area) {
  currentArea = area;
  document.querySelectorAll('.area-btn').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.a === area ? 'true' : 'false');
  });

  if (currentView === 'list') {
    renderList();
  } else {
    applyTimelineAreaFilter();
  }
}

function applyTimelineAreaFilter() {
  const golfCard = document.getElementById('golfTimelineCard');
  const arenaCard = document.getElementById('arenaTimelineCard');

  if (ALLOWED_PROPERTIES.length === 2) {
    if (golfCard) golfCard.style.display = 'none';
    if (arenaCard) arenaCard.style.display = 'block';
    return;
  }
  if (ALLOWED_PROPERTIES.length === 3) {
    if (golfCard) golfCard.style.display = 'block';
    if (arenaCard) arenaCard.style.display = 'none';
    return;
  }

  if (currentArea === 'golf') {
    if (golfCard) golfCard.style.display = 'block';
    if (arenaCard) arenaCard.style.display = 'none';
  } else if (currentArea === 'arena') {
    if (golfCard) golfCard.style.display = 'none';
    if (arenaCard) arenaCard.style.display = 'block';
  } else {
    if (golfCard) golfCard.style.display = 'block';
    if (arenaCard) arenaCard.style.display = 'block';
  }
}

function filterType(type) {
  currentType = type;
  document.querySelectorAll('.type-btn').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.f === type ? 'true' : 'false');
  });
  renderList();
}

document.getElementById('q').addEventListener('input', ev => {
  searchQuery = ev.target.value;
  renderList();
});

let toastTimer = null;
function showToast(htmlMsg) {
  const t = document.getElementById('toast');
  t.innerHTML = htmlMsg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 3500);
}

async function triggerSync() {
  const btn = document.getElementById('syncBtn');
  if (!btn) return;
  const icon = document.getElementById('syncIcon');
  const txt = document.getElementById('syncText');

  btn.disabled = true;
  icon.textContent = '⏳';
  txt.textContent = 'Szinkronizálás...';

  showToast('🔄 Szinkronizálás folyamatban a Lodgify-jal...');

  try {
    const resp = await fetch('?action=update');
    const msgTxt = await resp.text();

    if (resp.ok) {
      showToast('✅ ' + msgTxt);
      setTimeout(() => location.reload(), 1200);
    } else {
      showToast(msgTxt);
      btn.disabled = false;
      icon.textContent = '🔄';
      txt.textContent = 'Frissítés';
    }
  } catch (err) {
    showToast('⚠️ Frissítési hiba: ' + err.message);
    btn.disabled = false;
    icon.textContent = '🔄';
    txt.textContent = 'Frissítés';
  }
}

async function logout() {
  if (!confirm('Biztosan ki szeretnél jelentkezni?')) return;
  try {
    await fetch(window.location.origin + window.location.pathname, {
      headers: { "Authorization": "Basic " + btoa("logout:logout") }
    });
  } catch (e) {}
  window.location.href = window.location.origin + window.location.pathname;
}

renderList();
applyTimelineAreaFilter();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

// --------------------- Settings Endpoint Handler ---------------------
async function handleSettingsPost(request, env) {
  try {
    const data = await request.json();
    const { name, columns } = data;

    if (!name || !columns || !Array.isArray(columns)) {
      return new Response("Invalid input", { status: 400 });
    }

    const value = JSON.stringify(columns);

    await env.DB.prepare(
      `INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`
    ).bind(name, value).run();

    return new Response("Settings saved", { status: 200 });
  } catch (err) {
    await logIssue(env, `Failed to save settings: ${err.message}`);
    return new Response("Internal Server Error", { status: 500 });
  }
}

// --------------------- Logging & Logs View ---------------------
async function logIssue(env, message, bookingId = null) {
  try {
    await env.DB.prepare(
      `INSERT INTO logs (message, booking_id, timestamp) VALUES (?, ?, ?)`
    ).bind(message, bookingId, new Date().toISOString()).run();
  } catch (err) {
    console.error("Failed to log issue to DB:", err);
  }
}

async function serveLogs(env, authUser = null) {
  const result = await env.DB.prepare("SELECT * FROM logs ORDER BY timestamp DESC LIMIT 200").all();
  const columns = ["timestamp", "booking_id", "message"];

  let html = `<!DOCTYPE html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rendszernaplók - Cleaning Calendar</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 16px;
    background: #fdfdfd;
    color: #1f2937;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 2px solid #e5e7eb;
  }
  h2 { margin: 0; }
  .btn {
    padding: 8px 14px;
    font-size: 13px;
    cursor: pointer;
    border-radius: 6px;
    border: 1px solid #d1d5db;
    background: #ffffff;
    color: #374151;
    text-decoration: none;
  }
  .btn:hover { background: #f3f4f6; }
  .container {
    overflow-x: auto;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
  }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; }
  th { background: #f9fafb; font-weight: 600; }
  tr:nth-child(even) { background: #fafafa; }
  .err { background-color: #fee2e2; color: #991b1b; font-weight: 600; }
  .succ { background-color: #ecfdf5; color: #065f46; font-weight: 600; }
</style>
</head>
<body>
<div class="header">
  <h2>📋 Rendszernaplók (System Logs)</h2>
  <button type="button" onclick="location.href='?view=all'" class="btn">⬅️ Vissza a naptárhoz</button>
</div>
<div class="container">
<table>
  <thead>
    <tr>${columns.map(c => `<th>${c}</th>`).join("")}</tr>
  </thead>
  <tbody>`;

  if (result.results) {
    for (const row of result.results) {
      const msg = row.message || "";
      let cls = "";
      if (msg.includes("failed") || msg.includes("error") || msg.includes("429")) cls = "class=\"err\"";
      else if (msg.includes("complete") || msg.includes("✅")) cls = "class=\"succ\"";
      html += `<tr ${cls}>` + columns.map(c => `<td>${row[c] || ""}</td>`).join("") + `</tr>`;
    }
  }

  html += `</tbody>
</table>
</div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
