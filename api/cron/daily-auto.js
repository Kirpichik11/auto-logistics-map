// /api/cron/daily-auto.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Формат ddMMyyyyHHmm
function formatContractNo(d) {
  const pad = (n) => String(n).padStart(2, "0");
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  const HH = pad(d.getHours());
  const MM = pad(d.getMinutes());
  return `${dd}${mm}${yyyy}${HH}${MM}`;
}

// YYYY-MM-DD (UTC) — для “замка” cron
function utcRunDateString(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Случайное время сегодня (10:00–20:00) по UTC
// Если хочешь по местному времени — скажи, переделаю под Europe/Zagreb.
function randomTimeTodayUtc() {
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const hour = 10 + Math.floor(Math.random() * 11); // 10..20
  const minute = Math.floor(Math.random() * 60);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

export default async function handler(req, res) {
  try {
    // 1) Замок: отмечаем, что cron на сегодня уже выполнялся
    const today = new Date();
    const run_date = utcRunDateString(today);

    const lockInsert = await supabase
      .from("auto_gen_log")
      .insert([{ run_date, status: "started", created_at: new Date().toISOString() }])
      .select()
      .single();

    // Если уникальный индекс сработал — значит cron уже был сегодня
    if (lockInsert.error) {
      // 23505 = unique_violation
      if (lockInsert.error.code === "23505") {
        return res.status(200).json({ ok: true, skipped: true, reason: "cron already ran today", run_date });
      }
      return res.status(500).json({ ok: false, error: lockInsert.error.message });
    }

    const logRowId = lockInsert.data?.id;

    // 2) Получаем настройки автогенерации
    const settingsResp = await supabase
      .from("auto_gen_settings")
      .select("start_hub_ids,end_hub_ids")
      .limit(1)
      .single();

    if (settingsResp.error) {
      await supabase.from("auto_gen_log").update({ status: "failed", error: settingsResp.error.message }).eq("id", logRowId);
      return res.status(500).json({ ok: false, error: settingsResp.error.message });
    }

    const startHubIds = settingsResp.data?.start_hub_ids || [];
    const endHubIds = settingsResp.data?.end_hub_ids || [];

    if (!startHubIds.length || !endHubIds.length) {
      const msg = "auto_gen_settings.start_hub_ids or end_hub_ids is empty";
      await supabase.from("auto_gen_log").update({ status: "failed", error: msg }).eq("id", logRowId);
      return res.status(400).json({ ok: false, error: msg });
    }

    const startHubId = startHubIds[Math.floor(Math.random() * startHubIds.length)];
    const endHubId = endHubIds[Math.floor(Math.random() * endHubIds.length)];

    // 3) Получаем маршрут через централизованный механизм (route_suggest)
    // ВАЖНО: это вызов внутреннего API. На Vercel правильнее дергать абсолютный URL.
    // Берем из заголовков host.
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const baseUrl = `${proto}://${host}`;

    const routeResp = await fetch(`${baseUrl}/api/admin/route_suggest.js`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startHubId, endHubId })
    });

    if (!routeResp.ok) {
      const text = await routeResp.text();
      await supabase.from("auto_gen_log").update({ status: "failed", error: `route_suggest failed: ${text}` }).eq("id", logRowId);
      return res.status(500).json({ ok: false, error: "route_suggest failed", details: text });
    }

    const routeJson = await routeResp.json();
    const route_hub_ids = routeJson?.route_hub_ids;

    if (!Array.isArray(route_hub_ids) || route_hub_ids.length < 2) {
      const msg = "route_suggest returned invalid route_hub_ids";
      await supabase.from("auto_gen_log").update({ status: "failed", error: msg }).eq("id", logRowId);
      return res.status(500).json({ ok: false, error: msg, routeJson });
    }

    // 4) Генерим авто
    const start_time = randomTimeTodayUtc();
    const baseContractNo = formatContractNo(start_time);

    // Если вдруг коллизия contract_no — пробуем добавить суффикс
    let contract_no = baseContractNo;
    let createdCar = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) contract_no = `${baseContractNo}-${attempt}`;

      const insertCar = await supabase
        .from("cars")
        .insert([
          {
            vin: crypto.randomUUID(), // VIN = uuid (как в ТЗ)
            contract_no,
            brand: "AUTO",
            model: "GEN",
            photo_url: null,
            urgency: "normal",
            start_time: start_time.toISOString(),
            route_hub_ids,
            public: true,
            is_deleted: false
          }
        ])
        .select()
        .single();

      if (!insertCar.error) {
        createdCar = insertCar.data;
        break;
      }

      // 23505 = уникальность (contract_no)
      if (insertCar.error.code !== "23505") {
        await supabase.from("auto_gen_log").update({ status: "failed", error: insertCar.error.message }).eq("id", logRowId);
        return res.status(500).json({ ok: false, error: insertCar.error.message });
      }
    }

    if (!createdCar) {
      const msg = "Failed to create car: contract_no collisions";
      await supabase.from("auto_gen_log").update({ status: "failed", error: msg }).eq("id", logRowId);
      return res.status(500).json({ ok: false, error: msg });
    }

    // 5) Успех — пишем лог
    await supabase
      .from("auto_gen_log")
      .update({ status: "success", car_id: createdCar.id })
      .eq("id", logRowId);

    return res.status(200).json({ ok: true, run_date, car_id: createdCar.id, contract_no: createdCar.contract_no });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
