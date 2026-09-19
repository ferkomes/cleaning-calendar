// Build version: 2026-09-19-build-3 (Lodgify v2 integration, 5-min sync cooldown, working view switching & logout)
let detailsStatus = "idle";
// idle | processing | done | failed

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
    const user = rawUser.toLowerCase();
    const pass = decoded.substring(colonIndex + 1);

    // 1. Admin (Jelszó: Kurvaanyad1!)
    if (pass === "Kurvaanyad1!" && (
      user === "admin" || user === "ferkomes" || user === "ferenc" || user === ""
    )) {
      return { role: "admin", username: rawUser || "Admin" };
    }

    // 2. LaArena / Kata (Jelszó: Kata1!)
    if (pass === "Kata1!" && (
      user === "laarena" || user === "la-arena" || user === "kata" || user === ""
    )) {
      return { role: "la-arena", username: "Kata (La-Arena)" };
    }

    // 3. GolfDelSur / Gábor (Jelszó: Gabor1!)
    if (pass === "Gabor1!" && (
      user === "golfdelsur" || user === "golf-del-sur" || user === "gabor" || user === "gábor" || user === ""
    )) {
      return { role: "golf-del-sur", username: "Gábor (Golf-del-Sur)" };
    }

    // Fallback ha a jelszó egyértelműen stimmel
    if (pass === "Kurvaanyad1!") return { role: "admin", username: rawUser || "Admin" };
    if (pass === "Kata1!") return { role: "la-arena", username: "Kata (La-Arena)" };
    if (pass === "Gabor1!") return { role: "golf-del-sur", username: "Gábor (Golf-del-Sur)" };

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

      // Kijelentkezés (Basic Auth böngésző cache törlése)
      if (action === "logout" || pathname === "/logout") {
        return unauthorizedResponse("Sikeresen kijelentkeztél. Újbóli belépéshez töltsd újra az oldalt vagy add meg az új bejelentkezési adatokat.");
      }

      // HTTP Basic Authentication ellenőrzése
      const auth = authenticateUser(request);
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
          await batchUpsertBookings(env, rows);
          await markSyncDone(env);
          await logIssue(env, `✅ Sikeres szinkronizáció: ${rows.length} foglalás mentve (${auth.username}).`);
          return new Response(JSON.stringify({ success: true, count: rows.length }), {
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

  const mappedRows = validBookings.map(item => mapBooking(item, PROPERTIES_MAP));

  if (mappedRows.length) {
    await batchUpsertBookings(env, mappedRows);
    const validIds = mappedRows.map(r => r.booking_id);
    await pruneStaleBookings(env, validIds, periodStart);
  }

  await logIssue(env, `✅ Lodgify szinkronizáció sikeres: ${mappedRows.length} aktív foglalás és időszak frissítve.`);
  return { success: true, count: mappedRows.length, version: "v1" };
}

// --------------------- Mapping and Batch Upsert ---------------------
function mapBooking(item, propertiesMap = PROPERTIES_MAP) {
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

  return {
    booking_id: String(item.id).replace('.0', ''),
    property_name: propName,
    people,
    guest_name: guestName,
    guest_phone: guestPhone,
    lockbox_code: lockbox,
    check_in_date: item.arrival ? item.arrival.slice(0, 10) : "",
    check_in_time: item.check_in?.time || "16:00:00",
    departure: item.departure ? item.departure.slice(0, 10) : "",
    check_out_time: item.check_out?.time || "11:00:00",
    note: item.note ? cleanNote(item.note) : "",
    detail_status: "DONE"
  };
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
  if (!validIds || !validIds.length) return;
  try {
    const existing = await env.DB.prepare(
      "SELECT booking_id FROM bookings WHERE departure >= ?"
    ).bind(periodStart).all();

    const validSet = new Set(validIds.map(id => String(id).replace('.0', '')));
    const idsToDelete = (existing.results || [])
      .map(r => String(r.booking_id))
      .filter(id => !validSet.has(id.replace('.0', '')));

    if (idsToDelete.length > 0) {
      const BATCH_SIZE = 25;
      for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
        const chunk = idsToDelete.slice(i, i + BATCH_SIZE);
        const statements = chunk.map(id =>
          env.DB.prepare("DELETE FROM bookings WHERE booking_id = ?").bind(id)
        );
        await env.DB.batch(statements);
      }
      await logIssue(env, `🧹 Törölve ${idsToDelete.length} lemondott/stale foglalás.`);
    }
  } catch (err) {
    console.error("Prune error:", err);
  }
}

function cleanNote(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>?/gm, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
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
  if (properties.length) {
    whereClause = `WHERE property_name IN (${properties.map((_, i) => `?${i + 1}`).join(",")})`;
    bindParams = properties;
  }
  const sql = `SELECT * FROM bookings ${whereClause} ORDER BY check_in_date ASC`;
  const rows = await env.DB.prepare(sql).bind(...bindParams).all();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const now = new Date();

  const upcomingBookings = (rows.results || []).filter(r => new Date(r.check_in_date) >= today);
  const earliestArrivalDate = upcomingBookings.length > 0 ? new Date(upcomingBookings[0].check_in_date) : null;

  let nextArrivalIds = new Set();
  if (earliestArrivalDate) {
    nextArrivalIds = new Set(
      upcomingBookings
        .filter(r => new Date(r.check_in_date).toDateString() === earliestArrivalDate.toDateString())
        .map(r => r.booking_id)
    );
  }

  const columns = [
    "booking_id", "property_name", "people", "guest_name", "guest_phone",
    "lockbox_code", "check_in_date", "check_in_time", "departure", "check_out_time", "note", "detail_status"
  ];

  // Column Visibility Settings
  const laArenaSettingsResult = await env.DB.prepare("SELECT value FROM settings WHERE name = 'La-Arena-Columns'").first();
  const golfDelSurSettingsResult = await env.DB.prepare("SELECT value FROM settings WHERE name = 'Golf-del-Sur-Columns'").first();

  let laArenaCols = columns;
  let golfDelSurCols = columns;

  if (laArenaSettingsResult && laArenaSettingsResult.value) {
    try {
      const parsed = JSON.parse(laArenaSettingsResult.value);
      if (Array.isArray(parsed)) laArenaCols = parsed;
    } catch (e) {}
  }

  if (golfDelSurSettingsResult && golfDelSurSettingsResult.value) {
    try {
      const parsed = JSON.parse(golfDelSurSettingsResult.value);
      if (Array.isArray(parsed)) golfDelSurCols = parsed;
    } catch (e) {}
  }

  let currentVisibleCols = columns;
  if (title.includes("La-Arena") && laArenaCols.length) {
    currentVisibleCols = laArenaCols;
  } else if (title.includes("Golf-del-Sur") && golfDelSurCols.length) {
    currentVisibleCols = golfDelSurCols;
  }

  const isAllBookings = title === "All Bookings";
  const isAdmin = authUser && authUser.role === "admin";

  // Last Sync status check
  const cooldownCheck = await checkSyncCooldown(env);
  let lastSyncText = "";
  if (cooldownCheck.lastSyncIso) {
    const d = new Date(cooldownCheck.lastSyncIso);
    lastSyncText = `Utolsó szinkronizáció: ${d.toLocaleTimeString("hu-HU", { hour: '2-digit', minute: '2-digit' })}`;
  }

  let html = `<!DOCTYPE html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Takarítási Naptár</title>
<style>
  :root {
    --primary: #2563eb;
    --primary-hover: #1d4ed8;
    --success: #059669;
    --success-hover: #047857;
    --bg-light: #f9fafb;
    --border-color: #e5e7eb;
    --text-main: #1f2937;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 16px;
    background: #fdfdfd;
    color: var(--text-main);
  }
  .header-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 2px solid var(--border-color);
  }
  .header-title {
    font-size: 22px;
    font-weight: 700;
    margin: 0;
    color: #111827;
  }
  .user-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 9999px;
    font-size: 13px;
    color: #374151;
    cursor: pointer;
    transition: all 0.15s ease;
    user-select: none;
  }
  .user-badge:hover {
    background: #fee2e2;
    border-color: #fca5a5;
    color: #991b1b;
  }
  .logout-btn {
    font-size: 11px;
    background: #e5e7eb;
    padding: 2px 8px;
    border-radius: 9999px;
    font-weight: 600;
    transition: all 0.15s;
  }
  .user-badge:hover .logout-btn {
    background: #ef4444;
    color: white;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .nav-btn {
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 6px;
    border: 1px solid #d1d5db;
    background: #ffffff;
    color: #374151;
    transition: all 0.15s ease;
  }
  .nav-btn:hover {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
  .nav-active {
    background: var(--primary) !important;
    color: #ffffff !important;
    border-color: var(--primary) !important;
    box-shadow: 0 1px 2px rgba(37, 99, 235, 0.2);
  }
  .sync-btn {
    background: var(--success) !important;
    color: white !important;
    border-color: var(--success) !important;
    font-weight: 600;
  }
  .sync-btn:hover {
    background: var(--success-hover) !important;
  }
  .sync-btn:disabled {
    background: #9ca3af !important;
    border-color: #9ca3af !important;
    cursor: not-allowed;
  }
  .sync-meta {
    font-size: 12px;
    color: #6b7280;
    margin-left: auto;
  }
  .container {
    overflow-x: auto;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 13px;
  }
  th, td {
    border: 1px solid #e5e7eb;
    padding: 8px 10px;
    text-align: left;
    white-space: nowrap;
  }
  th {
    background: #f9fafb;
    color: #374151;
    font-weight: 600;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  tr:nth-child(even) { background: #fafafa; }
  tr:hover { background: #f0fdf4; }
  .green { background: #dcfce7 !important; font-weight: 600; }
  .blue { background: #e0f2fe !important; }
  .grey { background: #f3f4f6 !important; color: #9ca3af; }
  #syncMsg {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 9999;
    background: #10b981;
    color: #ffffff;
    padding: 10px 18px;
    border-radius: 8px;
    box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06);
    font-size: 13px;
    font-weight: 600;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
  }
  @media(max-width: 640px) {
    body { padding: 10px; }
    th, td { font-size: 12px; padding: 6px; }
    .header-title { font-size: 18px; }
    .nav-btn { padding: 6px 10px; font-size: 12px; }
  }
</style>
</head>
<body>

<div id="syncMsg"></div>

<div class="header-bar">
  <div style="display:flex; align-items:center; gap: 12px;">
    <h1 class="header-title">${title}</h1>
  </div>
  ${authUser ? `
  <div class="user-badge" onclick="logout()" title="Kattints ide a kijelentkezéshez">
    <span>👤 <strong>${authUser.username}</strong></span>
    <span class="logout-btn">🚪 Kilépés</span>
  </div>
  ` : ''}
</div>

<div class="toolbar">
  ${isAdmin ? `
    <button type="button" onclick="location.href='?view=all'" class="nav-btn ${title === 'All Bookings' ? 'nav-active' : ''}">Összes apartman</button>
    <button type="button" onclick="location.href='?view=la-arena'" class="nav-btn ${title.includes('La-Arena') ? 'nav-active' : ''}">La-Arena (Kata)</button>
    <button type="button" onclick="location.href='?view=golf-del-sur'" class="nav-btn ${title.includes('Golf-del-Sur') ? 'nav-active' : ''}">Golf-del-Sur (Gábor)</button>
    <button type="button" onclick="location.href='?view=logs'" class="nav-btn">Rendszernaplók (Logs)</button>
  ` : ''}
  <button type="button" id="updateBtn" onclick="updateTable()" class="nav-btn sync-btn">🔄 Frissítés (Sync)</button>
  ${lastSyncText ? `<span class="sync-meta">${lastSyncText}</span>` : ''}
</div>
`;

  // --- Admin iCal Feed és Oszlop Láthatóság Panel ---
  if (isAdmin && title === "All Bookings") {
    html += `
<div style="background:#f0f9ff; padding:14px; border-radius:8px; margin-bottom:16px; border:1px solid #bae6fd;">
  <h3 style="margin-top:0; font-size:15px; color:#0369a1;">📅 iCal Naptár Feed Linkek (Automatikus szinkronizációhoz)</h3>
  <p style="font-size:13px; color:#0c4a6e; margin-bottom:8px;">Másold ki az alábbi linkeket a Google Naptárba, Outlookba vagy Apple Calendarba történő beillesztéshez:</p>
  <div style="margin-bottom:8px;">
    <strong style="font-size:13px;">La-Arena iCal:</strong>
    <code id="laArenaIcal" style="display:block; background:#fff; padding:6px 10px; border:1px solid #cbd5e1; border-radius:4px; font-size:12px; margin-top:4px; word-break:break-all;">https://${host}/la-arena-ical</code>
  </div>
  <div>
    <strong style="font-size:13px;">Golf-del-Sur iCal:</strong>
    <code id="golfIcal" style="display:block; background:#fff; padding:6px 10px; border:1px solid #cbd5e1; border-radius:4px; font-size:12px; margin-top:4px; word-break:break-all;">https://${host}/golf-del-sur-ical</code>
  </div>
</div>

<details style="margin-bottom:16px; background:#fafafa; border:1px solid #e5e7eb; border-radius:8px; padding:12px;">
  <summary style="font-weight:600; cursor:pointer; font-size:14px; color:#374151;">⚙️ Oszlop Láthatóság Beállítása (Kata és Gábor nézeteihez)</summary>
  <div style="display:flex; gap:20px; flex-wrap:wrap; margin-top:12px;">
    <div style="flex:1; min-width:260px; padding:12px; background:#fff; border:1px solid #e5e7eb; border-radius:6px;">
      <h4 style="margin-top:0; font-size:14px;">La-Arena Oszlopok</h4>
      <form id="laArenaForm">
        <input type="hidden" name="name" value="La-Arena-Columns">
        ${columns.map(c => `
          <div style="margin-bottom:4px; font-size:13px;">
            <label style="cursor:pointer;">
              <input type="checkbox" name="column" value="${c}" ${laArenaCols.includes(c) ? 'checked' : ''}>
              ${c}
            </label>
          </div>
        `).join('')}
        <button type="button" onclick="saveSettings('laArenaForm')" class="nav-btn" style="margin-top:8px; background:#2563eb; color:white; border-color:#2563eb;">Mentés (La-Arena)</button>
      </form>
    </div>

    <div style="flex:1; min-width:260px; padding:12px; background:#fff; border:1px solid #e5e7eb; border-radius:6px;">
      <h4 style="margin-top:0; font-size:14px;">Golf-del-Sur Oszlopok</h4>
      <form id="golfForm">
        <input type="hidden" name="name" value="Golf-del-Sur-Columns">
        ${columns.map(c => `
          <div style="margin-bottom:4px; font-size:13px;">
            <label style="cursor:pointer;">
              <input type="checkbox" name="column" value="${c}" ${golfDelSurCols.includes(c) ? 'checked' : ''}>
              ${c}
            </label>
          </div>
        `).join('')}
        <button type="button" onclick="saveSettings('golfForm')" class="nav-btn" style="margin-top:8px; background:#2563eb; color:white; border-color:#2563eb;">Mentés (Golf-del-Sur)</button>
      </form>
    </div>
  </div>
</details>
`;
  }

  // --- Táblázat Fejléc és Tartalom ---
  const headerHtml = columns.map(c => {
    const isHidden = !isAllBookings && !currentVisibleCols.includes(c);
    const style = isHidden ? 'style="display:none;"' : '';
    const checkbox = isAllBookings ? `<input type="checkbox" ${currentVisibleCols.includes(c) ? 'checked' : ''} onchange="toggleColumn(event,'${c}')" style="margin-right:6px;">` : '';
    return `<th ${style}>${checkbox}${c}</th>`;
  }).join("");

  html += `<div class="container"><table id="bookingTable"><thead><tr>${headerHtml}</tr></thead><tbody>`;

  for (const row of (rows.results || [])) {
    const arrival = new Date(row.check_in_date);
    const departure = new Date(row.departure);
    arrival.setHours(0, 0, 0, 0);
    departure.setHours(0, 0, 0, 0);

    let cls = "";
    if (nextArrivalIds.has(row.booking_id)) {
      cls = "green";
    } else if (arrival <= now && departure >= now) {
      cls = "blue";
    } else if (arrival < today) {
      cls = "grey";
    }

    html += `<tr class="${cls}">` + columns.map(c => {
      const isHidden = !isAllBookings && !currentVisibleCols.includes(c);
      const style = isHidden ? 'style="display:none;"' : '';
      return `<td ${style}>${row[c] || ""}</td>`;
    }).join("") + `</tr>`;
  }

  html += `</tbody></table></div>

<script>
window.onload = function() {
  const greenRow = document.querySelector("tr.green");
  if (greenRow) greenRow.scrollIntoView({ behavior: "smooth", block: "center" });

  // Update iCal URLs with current origin
  const origin = window.location.origin;
  const laEl = document.getElementById("laArenaIcal");
  const golfEl = document.getElementById("golfIcal");
  if (laEl) laEl.textContent = origin + "/la-arena-ical";
  if (golfEl) golfEl.textContent = origin + "/golf-del-sur-ical";
};

// Kijelentkezés
async function logout() {
  if (!confirm("Biztosan ki szeretnél jelentkezni?")) return;
  try {
    await fetch(window.location.pathname + "?action=logout", {
      headers: { "Authorization": "Basic " + btoa("logout:logout") }
    });
  } catch (e) {}
  window.location.href = window.location.pathname + "?action=logout";
}

// Szinkronizálás (Sync)
async function updateTable() {
  const btn = document.querySelector("#updateBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Szinkronizálás folyamatban...";
  }

  const msg = document.getElementById("syncMsg");
  try {
    const resp = await fetch(window.location.pathname + "?action=update");
    const txt = await resp.text();

    if (msg) {
      msg.textContent = txt;
      msg.style.opacity = 1;
      msg.style.background = resp.ok && !txt.includes("⏳") ? "#10b981" : "#f59e0b";
      setTimeout(() => { msg.style.opacity = 0; }, 4500);
    }

    if (resp.ok && !txt.includes("⏳")) {
      setTimeout(() => location.reload(), 1500);
    } else {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "🔄 Frissítés (Sync)";
      }
    }
  } catch (e) {
    alert("Frissítési hiba: " + e);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🔄 Frissítés (Sync)";
    }
  }
}

// Oszlop ki/be kapcsolás
function toggleColumn(event, col) {
  const checked = event.target.checked;
  const headers = [...document.querySelectorAll("#bookingTable th")];
  const idx = headers.findIndex(th => th.textContent.includes(col));
  if (idx < 0) return;
  document.querySelectorAll("#bookingTable tr").forEach(tr => {
    if (tr.cells[idx]) tr.cells[idx].style.display = checked ? "" : "none";
  });
}

// Beállítások mentése
async function saveSettings(formId) {
  const form = document.getElementById(formId);
  const name = form.elements['name'].value;
  const selectedColumns = [];

  form.elements['column'].forEach(checkbox => {
    if (checkbox.checked) {
      selectedColumns.push(checkbox.value);
    }
  });

  try {
    const resp = await fetch(window.location.pathname + '?action=save-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, columns: selectedColumns })
    });

    const msg = document.getElementById("syncMsg");
    if (msg) {
      msg.textContent = resp.ok ? '✅ ' + name + ' sikeresen mentve!' : '⚠️ Nem sikerült a mentés.';
      msg.style.opacity = 1;
      msg.style.background = resp.ok ? "#10b981" : "#ef4444";
      setTimeout(() => { msg.style.opacity = 0; }, 3000);
    }

    if (resp.ok) {
      setTimeout(() => location.reload(), 800);
    }
  } catch (e) {
    alert("Hiba a mentés során: " + e);
  }
}
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
