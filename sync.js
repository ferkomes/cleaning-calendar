// Standalone Sync Runner for Lodgify -> Cloudflare D1
// Can be run anytime locally via: node sync.js

const LODGIFY_API_KEY = "JyVLrOAsPcxki39vyFGZ6H6RuXDpzbNFZTyIc//fMGJb51Zklzvj4aHnndsnx05C";
const WORKER_SYNC_URL = "https://ferkomes.com/894yu3hrjfebncdi7su888ybj4esnc/all-bookings?action=sync-push";
const ADMIN_AUTH = "Basic " + Buffer.from("admin:Kurvaanyad1!").toString("base64");
const GOLF_DEL_SUR_NOTIFICATION_EMAILS = [
  "Lymo.canari@gmail.com"
];

const GREEN_API_URL = "https://7107.api.greenapi.com";
const GREEN_API_ID_INSTANCE = "710722802966";
const GREEN_API_TOKEN = "51cbdb160011438ebdbf13cef9c18d99111f4e75f6234c5ca3";

const GOLF_DEL_SUR_WHATSAPP_RECIPIENTS = [
  "31629306180@c.us", // Feri (User)
  "34660541568@c.us"  // Cleaner (Golf del Sur)
];

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
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
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

  // 1. Fetch notes from Lodgify v2 Bookings API
  console.log("📝 Fetching notes and details from Lodgify v2...");
  const notesMap = new Map();
  try {
    let v2Page = 1;
    while (v2Page <= 10) {
      const v2Url = `https://api.lodgify.com/v2/reservations/bookings?page=${v2Page}&size=50&trash=False`;
      const v2Resp = await fetch(v2Url, {
        headers: {
          "X-ApiKey": LODGIFY_API_KEY,
          "Accept": "application/json"
        }
      });
      if (!v2Resp.ok) break;
      const v2Data = await v2Resp.json();
      if (!v2Data || !v2Data.items || !v2Data.items.length) break;
      for (const item of v2Data.items) {
        const noteText = cleanNote(item.notes);
        if (noteText) {
          notesMap.set(String(item.id).replace('.0', ''), noteText);
        }
      }
      if (v2Data.items.length < 50) break;
      v2Page++;
    }
  } catch (err) {
    console.warn("⚠️ Could not fetch v2 notes batch:", err.message);
  }

  // 2. Fetch reservations from Lodgify v1 API (reliable for all bookings + closed periods)
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

  // 3. Check any active upcoming bookings that were not in the v2 paginated list
  const today = new Date().toISOString().slice(0, 10);
  const missingV2Bookings = validBookings.filter(item => {
    const id = String(item.id).replace('.0', '');
    return item.type === "Booking" && item.departure >= today && !notesMap.has(id);
  });

  if (missingV2Bookings.length > 0) {
    console.log(`🔍 Checking ${missingV2Bookings.length} active bookings individually for notes...`);
    await Promise.all(missingV2Bookings.map(async item => {
      const id = String(item.id).replace('.0', '');
      try {
        const resp = await fetch(`https://api.lodgify.com/v2/reservations/bookings/${id}`, {
          headers: {
            "X-ApiKey": LODGIFY_API_KEY,
            "Accept": "application/json"
          }
        });
        if (resp.ok) {
          const detail = await resp.json();
          const noteText = cleanNote(detail.notes);
          if (noteText) {
            notesMap.set(id, noteText);
          }
        }
      } catch (_) {}
    }));
  }

  console.log(`📝 Total bookings with notes identified: ${notesMap.size}`);

  const rows = validBookings.map(item => {
    const bookingId = String(item.id).replace('.0', '');
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

    const note = notesMap.get(bookingId) || (item.notes ? cleanNote(item.notes) : (item.note ? cleanNote(item.note) : ""));

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

    // Új Golf del Sur foglalások értesítéseinek kiküldése (Email + WhatsApp)
    const pending = pushResult.pendingNotifications || [];
    if (pending.length > 0) {
      console.log(`📬 ${pending.length} új Golf del Sur foglalás található, értesítések küldése (Email: ${GOLF_DEL_SUR_NOTIFICATION_EMAILS.join(", ")} | WhatsApp: ${GOLF_DEL_SUR_WHATSAPP_RECIPIENTS.join(", ")})...`);
      const successfullySent = [];

      for (const b of pending) {
        const bId = String(b.booking_id).replace('.0', '');
        let sentForThisBooking = false;

        // 1. Email küldés
        for (const recipientEmail of GOLF_DEL_SUR_NOTIFICATION_EMAILS) {
          try {
            const mailForm = new FormData();
            mailForm.append("name", "Cleaning Calendar");
            mailForm.append("email", recipientEmail);
            mailForm.append("productName", b.property_name || "Golf del Sur apartman");
            mailForm.append("subject", `🏨 Új foglalás: ${b.property_name} | ${b.check_in_date} – ${b.departure} (${b.guest_name})`);
            mailForm.append("requestType", "new_tractor_broadcast");

            const msgLines = [
              `Új foglalás érkezett a Golf del Sur apartmanra!`,
              ``,
              `Apartman: ${b.property_name}`,
              `Vendég neve: ${b.guest_name || 'Nincs megadva'}`,
              `Létszám: ${b.people || 'Nincs megadva'}`,
              `Érkezés (Check-in): ${b.check_in_date} ${b.check_in_time || '16:00:00'}`,
              `Távozás (Check-out): ${b.departure} ${b.check_out_time || '11:00:00'}`,
              `Telefonszám: ${b.guest_phone || 'Nincs megadva'}`,
              `Kulcsszéf kód (Lockbox): ${b.lockbox_code || '-'}`,
              `Megjegyzés (Note): ${b.note || 'Nincs'}`,
              ``,
              `Foglalás ID: #${bId}`,
              `Értesítés ideje: ${new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Madrid' })}`
            ];

            mailForm.append("message", msgLines.join("\n"));

            const mailRes = await fetch("https://ferkomes.com/email-sending", {
              method: "POST",
              body: mailForm
            });

            if (mailRes.ok) {
              console.log(`  ✅ Email sikeresen kiküldve #${bId} (${b.property_name}, ${b.guest_name}) -> ${recipientEmail}`);
              sentForThisBooking = true;
            } else {
              console.error(`  ❌ Hiba az email küldésekor (#${bId} -> ${recipientEmail}): HTTP ${mailRes.status}`);
            }
          } catch (mailErr) {
            console.error(`  ❌ Hiba az email küldésekor (#${bId} -> ${recipientEmail}):`, mailErr.message);
          }
        }

        // 2. WhatsApp küldés (Green-API)
        const checkInFormatted = `${b.check_in_date} (${b.check_in_time ? b.check_in_time.slice(0, 5) : '16:00'})`;
        const checkOutFormatted = `${b.departure} (${b.check_out_time ? b.check_out_time.slice(0, 5) : '11:00'})`;

        const waMessageLines = [
          `🏨 *NUEVA RESERVA / ÚJ FOGLALÁS*`,
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

        for (const waRecipient of GOLF_DEL_SUR_WHATSAPP_RECIPIENTS) {
          try {
            const waRes = await fetch(`${GREEN_API_URL}/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chatId: waRecipient,
                message: waMessage
              })
            });

            if (waRes.ok) {
              console.log(`  ✅ WhatsApp sikeresen kiküldve #${bId} (${b.property_name}) -> ${waRecipient}`);
              sentForThisBooking = true;
            } else {
              console.error(`  ❌ Hiba a WhatsApp küldésekor (#${bId} -> ${waRecipient}): HTTP ${waRes.status}`);
            }
          } catch (waErr) {
            console.error(`  ❌ Hiba a WhatsApp küldésekor (#${bId} -> ${waRecipient}):`, waErr.message);
          }
        }

        if (sentForThisBooking) {
          successfullySent.push(b);
        }
      }

      if (successfullySent.length > 0) {
        await fetch(WORKER_SYNC_URL.replace("action=sync-push", "action=mark-notified"), {
          method: "POST",
          headers: {
            "Authorization": ADMIN_AUTH,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ items: successfullySent })
        });
        console.log(`✅ ${successfullySent.length} értesítés sikeresen elmentve az adatbázisban.`);
      }
    }
  } else {
    console.error("❌ Failed to push to worker:", pushResult);
  }
}

sync().catch(err => {
  console.error("Fatal sync error:", err);
  process.exit(1);
});
