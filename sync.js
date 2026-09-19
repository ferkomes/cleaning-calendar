// Standalone Sync Runner for Lodgify -> Cloudflare D1
// Can be run anytime locally via: node sync.js

const LODGIFY_API_KEY = "JyVLrOAsPcxki39vyFGZ6H6RuXDpzbNFZTyIc//fMGJb51Zklzvj4aHnndsnx05C";
const WORKER_SYNC_URL = "https://ferkomes.com/894yu3hrjfebncdi7su888ybj4esnc/all-bookings?action=sync-push";
const ADMIN_AUTH = "Basic " + Buffer.from("admin:Kurvaanyad1!").toString("base64");

const PROPERTIES_MAP = {
  569854: "The Albatros",
  569855: "The Banana",
  573525: "The Colibri",
  569856: "The Pirate",
  569857: "The Tucan"
};

function cleanNote(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>?/gm, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .trim();
}

async function sync() {
  console.log("🚀 Starting Lodgify reservation fetch...");

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
    const resp = await fetch(url, {
      headers: {
        "X-ApiKey": LODGIFY_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!resp.ok) {
      throw new Error(`Lodgify returned HTTP ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json();
    if (!data || !data.items || !data.items.length) break;

    allItems.push(...data.items);
    if (data.items.length < limit) break;
    offset += limit;
  }

  console.log(`📦 Fetched ${allItems.length} total items from Lodgify.`);

  // Filter only 'booked' status (excludes 'Declined', 'Cancelled', 'Open')
  const validBookings = allItems.filter(item => {
    const status = (item.status || "").toLowerCase();
    return status === "booked" && !item.cancellationDate && !item.is_deleted;
  });

  console.log(`✅ Valid active bookings + closed periods: ${validBookings.length}`);

  const rows = validBookings.map(item => {
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

    const propName = PROPERTIES_MAP[item.property_id] || item.property_name || `Property #${item.property_id}`;
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
  });

  console.log(`📤 Pushing ${rows.length} rows to Cloudflare Worker...`);
  const pushResp = await fetch(WORKER_SYNC_URL, {
    method: "POST",
    headers: {
      "Authorization": ADMIN_AUTH,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ rows })
  });

  const pushResult = await pushResp.json();
  if (pushResp.ok && pushResult.success) {
    console.log(`🎉 SUCCESS! Updated ${pushResult.count} bookings in Cleaning Calendar.`);
  } else {
    console.error("❌ Failed to push to worker:", pushResult);
  }
}

sync().catch(err => {
  console.error("Fatal sync error:", err);
  process.exit(1);
});
