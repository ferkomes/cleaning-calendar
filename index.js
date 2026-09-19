let detailsStatus = "idle";
// idle | processing | done | stopped | failed

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/update") {
      try {
        await logIssue(env, "Starting full sync (Past/Future) and detail fetch for all missing entries.");
        detailsStatus = "processing";
        // Step 1: Sync all relevant bookings (past 32 days and 6 months future)
        const allBookingIds = await updateAllBookings(env); 
        // Step 2: Start prioritized detailed fetch in background
        ctx.waitUntil(startDetailedFetch(env));
        
        return new Response("✅ Full bookings sync complete. Detailed fetch for missing entries is running in the background.", {
          status: 200
        });
      } catch (err) {
        detailsStatus = "failed";
        await logIssue(env, `Update failed globally: ${err.message}`);
        return new Response("Update failed: " + err.message, {
          status: 500
        });
      }
    }
    
    // NEW: Handle column settings POST request
    if (pathname === "/save-settings" && request.method === "POST") {
        return handleSettingsPost(request, env);
    }
    
    // --- ICAL ROUTES VISSZAÁLLÍTVA (TOKEN NÉLKÜL) ---
    const host = request.headers.get('host') || 'worker.default.tld';
    
    if (pathname === "/golf-del-sur-ical") {
      // Visszaállítva a régi, egyszerű linkre
      return await serveIcalFeed(env, ["The Tucan", "The Colibri", "The Albatros"], "Golf-del-Sur-Columns", host);
    }
    if (pathname === "/la-arena-ical") {
      // Visszaállítva a régi, egyszerű linkre
      return await serveIcalFeed(env, ["The Banana", "The Pirate"], "La-Arena-Columns", host);
    }
    // --------------------------------------------------
    
    if (pathname === "/golf-del-sur") {
      return await serveTable(env, ["The Tucan", "The Colibri", "The Albatros"], "Golf-del-Sur");
    }
    if (pathname === "/la-arena") {
      return await serveTable(env, ["The Banana", "The Pirate"], "La-Arena");
    }
    
    if (pathname === "/894yu3hrjfebncdi7su888ybj4esnc/all-bookings" || pathname === "/894yu3hrjfebncdi7suybj4esnc/all-bookings") {
      return await serveTable(env, [], "All Bookings");
    }
    if (pathname === "/logs") {
      return await serveLogs(env);
    }
    return new Response("Not found", {
      status: 404
    });
  },
  
  // CRON: Cron Trigger Handler (Clears logs on minute 0 run)
  async scheduled(event, env, ctx) {
    const runTime = new Date(event.scheduledTime);
    const isMainRun = runTime.getUTCMinutes() === 0;

    if (isMainRun) {
        ctx.waitUntil(env.DB.prepare("DELETE FROM logs WHERE timestamp < datetime('now', '-7 days')").run());
        ctx.waitUntil(logIssue(env, `*** Log Cleanup Triggered (Older than 7 days) ***`));
    }
    
    ctx.waitUntil(logIssue(env, `Cron trigger received at minute ${runTime.getUTCMinutes()}. Starting automated sync.`));
    try {
      await updateAllBookings(env);
      ctx.waitUntil(startDetailedFetch(env));
    } catch (err) {
      ctx.waitUntil(logIssue(env, `Automated Cron Update failed: ${err.message}`));
    }
  },
};

// --------------------- Email (kept for context) --------------------
async function sendEmail(env, to, subject, htmlBody) {
  const apiKey = env.MAILJET_API_KEY; 
  const secretKey = env.MAILJET_SECRET_KEY; 
  const body = {
    Messages: [{
      From: {
        Email: "ferkomes@gmail.com",
        Name: "Cleaning Scheduler"
      },
      To: [{
        Email: to
      }],
      Subject: subject,
      HTMLPart: htmlBody
    }]
  };
  const response = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic " + btoa(`${apiKey}:${secretKey}`)
    },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  console.log("Mailjet send result:", result);
}

// --------------------- update all recent bookings (Conditional Reset Logic) ---------------------
async function updateAllBookings(env) {
  const apiKey = env.LODGIFY_API_KEY;
  if (!apiKey) throw new Error("LODGIFY_API_KEY not set");

  const baseApiUrl = "https://api.lodgify.com/v1/reservation";
  const headers = {
    "X-ApiKey": apiKey,
    "Accept": "application/json"
  };

  const thirtyTwoDaysAgo = new Date();
  thirtyTwoDaysAgo.setDate(thirtyTwoDaysAgo.getDate() - 32);
  const sixMonthsAhead = new Date(new Date().setMonth(new Date().getMonth() + 3));

  const periodStart = thirtyTwoDaysAgo.toISOString().slice(0, 10);
  const periodEnd = sixMonthsAhead.toISOString().slice(0, 10);

  let offset = 0;
  const limit = 50;
  const allBookingIds = [];
  
  const pendingCountResult = await env.DB.prepare(
      "SELECT COUNT(booking_id) as count FROM bookings WHERE detail_status = 'PENDING'"
  ).first();
  const allPendingCleared = pendingCountResult.count === 0; 
  const shouldResetAllStatus = allPendingCleared;
  
  await logIssue(env, `Pending check: ${pendingCountResult.count} bookings are PENDING. Reset All Status: ${shouldResetAllStatus}`);


  while (true) {
    const url = `${baseApiUrl}?offset=${offset}&limit=${limit}&trash=false&periodStart=${periodStart}&periodEnd=${periodEnd}`;
    
    let resp = await fetch(url, { headers });
    let retries = 0;
    while (resp.status === 429 && retries < 5) {
      const retryAfterHeader = resp.headers.get('Retry-After');
      const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 3000 * (retries + 1);
      await logIssue(env, `Lodgify 429 rate limit hit (offset=${offset}). Waiting ${waitMs}ms before retry #${retries + 1}.`);
      await delay(waitMs);
      resp = await fetch(url, { headers });
      retries++;
    }
    
    if (!resp.ok) throw new Error(`API fetch failed with status: ${resp.status}`);
    const data = await resp.json();
    
    await delay(300); // JAVÍTVA: kis szünet két lapozás között, hogy ne pörögjön túl gyorsan
    if (!data || !data.items || data.items.length === 0) break;
    const items = data.items;
    const fetchedIds = items.map(item => item.id);
    allBookingIds.push(...fetchedIds.map(String));
    
    // MODIFICATION START
    // Filter to only include 'booked' status AND no cancellation date
    const batchRows = items.filter(item => 
      item.status?.toLowerCase() === "booked" && 
      !item.cancellationDate
    ).map(mapBooking);
    // MODIFICATION END
    
    if (batchRows.length) await batchUpsertBookings(env, batchRows, 5, shouldResetAllStatus);
    
    if (items.length < limit) break;
    offset += limit;
  }
  
  return allBookingIds; 
}

// --------------------- Start Detailed Fetch (Process All Missing Details) ---------------------
async function startDetailedFetch(env) {
    const apiKey = env.LODGIFY_API_KEY;
    const detailApiUrl = "https://api.lodgify.com/v1/reservation/booking/";
    const headers = { "X-ApiKey": apiKey, "Accept": "application/json" };
    
    const bookingsNeedingDetails = await env.DB.prepare(
        "SELECT * FROM bookings WHERE detail_status = 'PENDING'"
    ).all();
    
    const now = new Date();
    const currentAndUpcoming = [];
    const past = [];

    for (const booking of bookingsNeedingDetails.results) {
        const departure = new Date(booking.departure);
        if (departure >= now) { 
            currentAndUpcoming.push(booking);
        } else {
            past.push(booking);
        }
    }
    
    currentAndUpcoming.sort((a, b) => new Date(a.check_in_date) - new Date(b.check_in_date));
    past.sort((a, b) => new Date(b.departure) - new Date(a.departure));

    const allIdsToFetch = [
        ...currentAndUpcoming.map(b => String(b.booking_id)),
        ...past.map(b => String(b.booking_id))
    ];
    
    const limitedIdsToFetch = allIdsToFetch; 
    
    await logIssue(env, `Starting detailed fetch for ${limitedIdsToFetch.length} bookings missing details. Processing all, first come first served.`);
    
    let successfulRequests = 0;
    for (const rawId of limitedIdsToFetch) {
        const id = parseInt(rawId, 10);
        if (isNaN(id)) {
            await logIssue(env, `Skipping invalid booking ID: ${rawId}`, rawId);
            continue;
        }
        
        await delay(100); 

        const url = `${detailApiUrl}${id}`; 
        
        try {
          const resp = await fetch(url, { headers });
          
          if (!resp.ok) {
            if (resp.status === 404) {
              await logIssue(env, `API returned status 404 for booking ID ${id}. Assuming removed.`, id);
              
              await env.DB.prepare(
                  `UPDATE bookings SET detail_status='DONE' WHERE booking_id=?`
              )
              .bind(id)
              .run();

            } else if (resp.status === 429 || resp.status >= 500) {
              await logIssue(env, `Rate/Subrequest error (status ${resp.status}) for ${id}. Skipping to next priority.`, id);
            } else {
              await logIssue(env, `API returned status ${resp.status} for booking ID ${id}.`, id);
            }
            continue;
          }

          const booking = await resp.json();
          if (!booking) {
            await logIssue(env, `Empty response for booking ID ${id}.`, id);
            continue;
          }

          const checkInTime = booking.check_in?.time || "";
          const checkOutTime = booking.check_out?.time || "";
          const note = booking.note ? cleanNote(booking.note) : "";
          
          await logIssue(env, `Fetched details. Notes: ${!!note ? 'YES' : 'NO'}, Time: ${!!checkInTime ? 'YES' : 'NO'}`, id);

          await env.DB.prepare(
              `UPDATE bookings SET check_in_time=?, check_out_time=?, note=?, detail_status='DONE' WHERE booking_id=?`
          )
          .bind(
              checkInTime,
              checkOutTime,
              note,
              id 
          )
          .run();
          
          successfulRequests++;

        } catch (err) {
            if (err.message && err.message.includes("Too many subrequests")) {
                
                await env.DB.prepare(
                    `UPDATE bookings SET detail_status='DONE' WHERE booking_id=?`
                )
                .bind(id)
                .run();
                
                await logIssue(env, `Fetch error: Too many subrequests for ${id}. Stopping detailed fetch.`, id);
                detailsStatus = "done"; 
                return; 
            }
            await logIssue(env, `Fetch error for booking ID ${id}: ${err.message}`, id);
            continue;
        }
    }
    
    detailsStatus = "done";
    await logIssue(env, `✅ Detailed fetch complete. Successfully updated ${successfulRequests} bookings.`);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --------------------- batch upsert (Conditional Reset Logic) ---------------------
async function batchUpsertBookings(env, rows, chunkSize, shouldReset) { 
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  
  const protectedFields = [
      'check_in_time', 
      'check_out_time', 
      'note' 
  ];

  const basicUpdateSet = columns
    .filter(c => !protectedFields.includes(c) && c !== 'detail_status')
    .map(c => `${c}=excluded.${c}`)
    .join(",");
  
  const statusUpdate = shouldReset 
    ? "detail_status = 'PENDING'" 
    : "detail_status = CASE WHEN detail_status = 'DONE' THEN 'DONE' ELSE excluded.detail_status END";
    
  const fullUpdateSet = `${basicUpdateSet}, ${statusUpdate}`;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(_ => `(${columns.map(_ => "?").join(",")})`).join(",");
    const values = chunk.flatMap(r => Object.values(r));
    
    const sql = `
      INSERT INTO bookings (${columns.join(",")})
      VALUES ${placeholders}
      ON CONFLICT(booking_id) 
      DO UPDATE SET ${fullUpdateSet}
    `;
    
    await env.DB.prepare(sql).bind(...values).run();
  }
}

// --------------------- map booking ---------------------
function mapBooking(booking) {
  const guest = booking.guest || {};
  const breakdown = booking.total_guest_breakdown || {};
  const people = [
    breakdown.adults ? `${breakdown.adults} adult${breakdown.adults>1?"s":""}` : "",
    breakdown.children ? `${breakdown.children} child${breakdown.children>1?"ren":""}` : "",
    breakdown.infants ? `${breakdown.infants} infant${breakdown.infants>1?"s":""}` : ""
  ].filter(Boolean).join(", ");
  const guestPhone = guest.phone || "";
  const rawLockbox = String(guestPhone).replace(/[^0-9]/g, ''); 
  const lockbox = rawLockbox.slice(-4) || "";
  return {
    booking_id: parseInt(booking.id, 10) || "", 
    property_name: booking.property_name || "",
    people,
    guest_name: guest.name || "",
    guest_phone: guestPhone,
    lockbox_code: lockbox,
    check_in_date: booking.arrival || "",
    check_in_time: booking.check_in?.time || "",
    departure: booking.departure || "",
    check_out_time: booking.check_out?.time || "",
    note: "", 
    detail_status: "PENDING"
  };
}

function cleanNote(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>?/gm, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .trim();
}

// --------------------- serveIcalFeed (TOKEN CHECK ELTÁVOLÍTVA) ---------------------

/**
 * Generates the iCal feed content for the specified properties, 
 * using the columns defined in the settings table.
 */
async function serveIcalFeed(env, properties, settingName, host) {
    // 1. TOKEN ELLENŐRZÉS ELTÁVOLÍTVA

    // --- Adatok lekérése ---
    let whereClause = "";
    let bindParams = [];
    if (properties.length) {
        whereClause = `WHERE property_name IN (${properties.map((_, i) => `?${i + 1}`).join(",")})`;
        bindParams = properties;
    }
    const sql = `SELECT * FROM bookings ${whereClause} ORDER BY check_in_date ASC`;
    const rowsResult = await env.DB.prepare(sql).bind(...bindParams).all();
    const bookings = rowsResult.results || [];

    // --- Oszlop beállítások lekérése ---
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

    // --- iCal tartalom generálása ---
    let ical = `BEGIN:VCALENDAR\r\n`;
    ical += `PRODID:-//Cloudflare Worker//Booking Scheduler v1.0//EN\r\n`;
    ical += `VERSION:2.0\r\n`;
    ical += `CALSCALE:GREGORIAN\r\n`;
    ical += `METHOD:PUBLISH\r\n`;
    ical += `X-WR-CALNAME:${settingName.replace("-Columns", "").replace("-", " ")} Bookings\r\n`;
    ical += `X-PUBLISHED-TTL:PT5M\r\n`; 

    for (const booking of bookings) {
        const dtstart = booking.check_in_date ? booking.check_in_date.replace(/-/g, '') : '';
        const dtend = booking.departure ? booking.departure.replace(/-/g, '') : ''; 

        if (!dtstart || !dtend) continue; 

        // 1. SUMMARY (Összefoglaló)
        let summaryParts = [];
        if (visibleColumns.includes('property_name')) summaryParts.push(booking.property_name); 
        if (visibleColumns.includes('guest_name') && booking.guest_name) summaryParts.push(booking.guest_name);
        else if (visibleColumns.includes('people') && booking.people) summaryParts.push(booking.people);
        
        let summary = summaryParts.filter(Boolean).join(' - ') || 'Foglalt';
        
        // 2. DESCRIPTION (Leírás)
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
        
        // 3. VEVENT esemény generálása
        ical += `BEGIN:VEVENT\r\n`;
        ical += `DTSTART;VALUE=DATE:${dtstart}\r\n`; 
        ical += `DTEND;VALUE=DATE:${dtend}\r\n`; 
        ical += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z\r\n`;
        ical += `UID:${booking.booking_id}@${host}\r\n`; 
        ical += `SUMMARY:${summary}\r\n`;
        // Removed `download` flag, but kept file content type
        ical += `DESCRIPTION:${description.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')}\r\n`;
        ical += `END:VEVENT\r\n`;
    }

    ical += `END:VCALENDAR\r\n`;

    return new Response(ical, {
        headers: {
            // Content-Disposition: `attachment; filename="${settingName.replace("-Columns", "").toLowerCase()}.ics"` ELTÁVOLÍTVA
            "Content-Type": "text/calendar; charset=utf-8", 
            "Cache-Control": "public, max-age=300" 
        },
    });
}


// --------------------- serve table (ICAL SECURITY SECTION ELTÁVOLÍTVA) ---------------------
async function serveTable(env, properties, title) {
  let whereClause = "";
  let bindParams = [];
  if (properties.length) {
    whereClause = `WHERE property_name IN (${properties.map((_,i)=>`?${i+1}`).join(",")})`;
    bindParams = properties;
  }
  const sql = `SELECT * FROM bookings ${whereClause} ORDER BY check_in_date ASC`;
  const rows = await env.DB.prepare(sql).bind(...bindParams).all();
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const now = new Date();
  
  const upcomingBookings = rows.results.filter(r => new Date(r.check_in_date) >= today);
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
  let statusMsg = "";
  if (detailsStatus === "processing") statusMsg = "🟠 Details are being processed for missing entries…";
  else if (detailsStatus === "done") statusMsg = "✅ Details update complete";
  else if (detailsStatus === "failed") statusMsg = "⚠️ Details update failed";


  // --- Column Selection Logic ---
  const laArenaSettingsResult = await env.DB.prepare("SELECT value FROM settings WHERE name = 'La-Arena-Columns'").first();
  const golfDelSurSettingsResult = await env.DB.prepare("SELECT value FROM settings WHERE name = 'Golf-del-Sur-Columns'").first();
  
  // TOKEN ELTÁVOLÍTVA: const icalTokenResult = await env.DB.prepare("SELECT value FROM settings WHERE name = 'ICAL_SECURITY_TOKEN'").first();
  
  let laArenaCols = columns;
  let golfDelSurCols = columns;

  if (laArenaSettingsResult && laArenaSettingsResult.value) {
      try {
          const parsed = JSON.parse(laArenaSettingsResult.value);
          if (Array.isArray(parsed)) laArenaCols = parsed;
      } catch (e) {
          console.error("Failed to parse La-Arena columns:", e);
      }
  }

  if (golfDelSurSettingsResult && golfDelSurSettingsResult.value) {
      try {
          const parsed = JSON.parse(golfDelSurSettingsResult.value);
          if (Array.isArray(parsed)) golfDelSurCols = parsed;
      } catch (e) {
          console.error("Failed to parse Golf-del-Sur columns:", e);
      }
  }

  let currentVisibleCols = columns; 
  if (title === "La-Arena" && laArenaCols.length) {
    currentVisibleCols = laArenaCols;
  } else if (title === "Golf-del-Sur" && golfDelSurCols.length) {
    currentVisibleCols = golfDelSurCols;
  }
  // --- END Column Selection Logic ---

  let html = `<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:Arial;margin:10px;}
button{padding:10px 15px;margin-bottom:10px;font-size:14px;cursor:pointer;border-radius:4px;}
table{border-collapse:collapse;width:100%;font-size:14px;}
th,td{border:1px solid #ccc;padding:6px;text-align:left;}
th{background:#f2f2f2;}
tr:nth-child(even){background:#fafafa;}
.green{background:lightgreen !important;}
.grey{background:lightgrey !important;}
.blue{background:lightblue !important;}
.container{overflow-x:auto;}
#syncMsg{position:fixed;top:5px;right:5px;background:#0a0;color:#fff;padding:6px 12px;border-radius:4px;opacity:0;transition:opacity 0.5s;}
#detailsProcessing{margin-bottom:10px;font-weight:bold;}
@media(max-width:600px){table,th,td{font-size:12px;padding:4px;}}
</style>
</head><body>
<h2>\${title}</h2>
`;
  if (title === "All Bookings") {
    html += `<button id="updateBtn" onclick="updateTable()">Update All Bookings</button>
<a href="/logs"><button>View Logs</button></a>`;
  }

  html += `<div id="syncMsg"></div>
\${statusMsg?\`<div id="detailsProcessing">\${statusMsg}</div>\`:\`\`}
`; 

  // --- COLUMN SELECTION FORM VISSZAÁLLÍTVA AZ ADMIN FELÜLETRE ---
  if (title === "All Bookings") {
    // Visszaállítva a korábbi, egyszerű ICAL linkek bemutatására
    const host = "worker.default.tld"; // Csak placeholder, a böngésző fogja behelyettesíteni

    html += `
<hr>
<div style="background:#f0f8ff; padding:10px; border-radius:4px; margin-bottom:15px; border:1px solid #b0e0e6;">
    <h4>iCal Feed Linkek (Biztonsági Token Nélkül)</h4>
    <p>Ezek a linkek most a Worker egyszerű elérési útját használják. Naptár programokba való beillesztéskor a böngésző megnyitásával ellenőrizhető a tartalom.</p>
    
    <p>**La-Arena iCal Link:**</p>
    <code style="font-family:monospace; background:#fff; padding:5px; border:1px solid #ddd; word-break:break-all; display:block; margin-bottom:8px;">https://\${host}/la-arena-ical</code>

    <p>**Golf-del-Sur iCal Link:**</p>
    <code style="font-family:monospace; background:#fff; padding:5px; border:1px solid #ddd; word-break:break-all; display:block; margin-bottom:8px;">https://\${host}/golf-del-sur-ical</code>
    <p style="font-size:12px; margin-top: 5px;">*A linket másolja ki, és illessze be a takarító csapat naptárrendszerébe (pl. Google Calendar, Outlook).*</p>
</div>
<hr>
`;
    // --- Column Selection Form ---
    html += `
<h3>Column Visibility Settings</h3>
<p>Select fields to display on the **La-Arena** and **Golf-del-Sur** pages (ezek mennek az iCal feedbe is).</p>
    
<div style="display:flex; gap: 20px; flex-wrap: wrap;">
  <div style="padding: 10px; border: 1px solid #ccc; border-radius: 5px;">
    <h4>La-Arena Columns</h4>
    <form id="laArenaForm">
      <input type="hidden" name="name" value="La-Arena-Columns">
      \${columns.map(c => \`
        <div>
          <input type="checkbox" name="column" value="\${c}" id="la-\${c}" 
            \${laArenaCols.includes(c) ? 'checked' : ''}>
          <label for="la-\${c}">\${c}</label>
        </div>
      \`).join('')}
      <button type="button" onclick="saveSettings('laArenaForm')">Save La-Arena</button>
    </form>
  </div>
  
  <div style="padding: 10px; border: 1px solid #ccc; border-radius: 5px;">
    <h4>Golf-del-Sur Columns</h4>
    <form id="golfForm">
      <input type="hidden" name="name" value="Golf-del-Sur-Columns">
      \${columns.map(c => \`
        <div>
          <input type="checkbox" name="column" value="\${c}" id="golf-\${c}" 
            \${golfDelSurCols.includes(c) ? 'checked' : ''}>
          <label for="golf-\${c}">\${c}</label>
        </div>
      \`).join('')}
      <button type="button" onclick="saveSettings('golfForm')">Save Golf-del-Sur</button>
    </form>
  </div>
</div>
<hr>`;
  }
  // --- END NEW FORM AND SECURITY SECTION ---

  // --- Start Table with Dynamic Header/Content ---
  const isAllBookings = title === "All Bookings";
  
  const headerHtml = columns.map(c => {
    const isHidden = !isAllBookings && !currentVisibleCols.includes(c);
    const style = isHidden ? 'style="display:none;"' : '';
    
    const checkbox = isAllBookings ? \`<input type="checkbox" \${currentVisibleCols.includes(c) ? 'checked' : ''} onchange="toggleColumn(event,'\${c}')">\` : '';
    
    return \`<th \${style}>\${checkbox}\${c}</th>\`;
  }).join("");


  html += \`<div class="container"><table id="bookingTable"><tr>\${headerHtml}</tr>\`;

  for (const row of rows.results) {
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

    html += \`<tr class="\${cls}">\` + columns.map(c => {
      const isHidden = !isAllBookings && !currentVisibleCols.includes(c);
      const style = isHidden ? 'style="display:none;"' : '';
      return \`<td \${style}>\${row[c]||""}</td>\`;
    }).join("") + \`</tr>\`;
  }

  html += \`</table></div>
<script>
// A Host nevet frissítő és a Token regeneráló funkciók ELTÁVOLÍTVA
// Visszaállítva az egyszerűbb onload-ra
window.onload=function(){
  const greenRow=document.querySelector("tr.green");
  if(greenRow) greenRow.scrollIntoView({behavior:"smooth"});

  // Host nevek frissítése a kód blokkokban (bár a linkek már egyszerűek)
  const host = window.location.host;
  document.querySelectorAll('code').forEach(codeBlock => {
    codeBlock.textContent = codeBlock.textContent.replace('worker.default.tld', host);
  });
};

async function updateTable(){
  const btn=document.querySelector("#updateBtn");
  btn.disabled=true; btn.textContent="Syncing...";
  try{
    const resp=await fetch("/update");
    const txt=await resp.text();
    const msg=document.getElementById("syncMsg");
    msg.textContent=txt;
    msg.style.opacity=1;
    setTimeout(()=>msg.style.opacity=0,3000);
    setTimeout(()=>location.reload(), 1500);
  }catch(e){
    alert("Update failed: "+e);
    btn.disabled=false; btn.textContent="Update All Bookings";
  }
}

function toggleColumn(event,col){
  const checked=event.target.checked;
  const headers = [...document.querySelectorAll("#bookingTable th")];
  const idx = headers.findIndex(th => th.textContent.includes(col)); 
  if(idx < 0) return;
  document.querySelectorAll("#bookingTable tr").forEach(tr=>{
    if(tr.cells[idx]) tr.cells[idx].style.display=checked?"":"none";
  });
}

// Save settings function
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
    const resp = await fetch('/save-settings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ name: name, columns: selectedColumns })
    });
    
    const msg = document.getElementById("syncMsg");
    msg.textContent = resp.ok ? '✅ ' + name + ' settings saved! Reload to see changes.' : '⚠️ Failed to save ' + name + '.';
    msg.style.opacity = 1;
    setTimeout(() => msg.style.opacity = 0, 3000);
    
    if(resp.ok) {
        setTimeout(() => location.reload(), 500);
    }


  } catch (e) {
    alert("Failed to save settings: " + e);
  }
}
</script>
</body></html>\`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html"
    }
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
      \`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value\`
    ).bind(name, value).run();
    
    return new Response("Settings saved", { status: 200 });
  } catch (err) {
    await logIssue(env, \`Failed to save settings: \${err.message}\`);
    return new Response("Internal Server Error", { status: 500 });
  }
}

// --------------------- New functions for logging ---------------------
async function logIssue(env, message, bookingId = null) {
  try {
    await env.DB.prepare(
      \`INSERT INTO logs (message, booking_id, timestamp) VALUES (?, ?, ?)\`
    ).bind(message, bookingId, new Date().toISOString()).run();
  } catch (err) {
    console.error("Failed to log issue to DB:", err);
  }
}

async function serveLogs(env) {
  const result = await env.DB.prepare("SELECT * FROM logs ORDER BY timestamp DESC LIMIT 200").all(); 

  const columns = ["timestamp", "booking_id", "message"];

  let html = \`<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:Arial;margin:10px;}
table{border-collapse:collapse;width:100%;font-size:14px;}
th,td{border:1px solid #ccc;padding:6px;text-align:left;}
th{background:#f2f2f2;}
tr:nth-child(even){background:#fafafa;}
.container{overflow-x:auto;}
</style>
</head><body>
<h2>System Logs</h2>
<a href="/all-bookings"><button>Back to Bookings</button></a>
<div class="container"><table id="logTable"><tr>\${columns.map(c=>\`<th>\${c}</th>\`).join("")}</tr>\`;

  if (result.results) {
    for (const row of result.results) {
      const messageClass = row.message && row.message.includes("Too many subrequests") ? 'style="background-color: #fdd; font-weight: bold;"' : '';
      html += \`<tr>\` + columns.map(c => \`<td \${messageClass}>\${row[c] || ""}</td>\`).join("") + \`</tr>\`;
    }
  }

  html += \`</table></div>
</body></html>\`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html"
    }
  });
}
