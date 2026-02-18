import { createClient } from "@supabase/supabase-js";
const BASE_URL = process.env.BASE_URL || "https://auto-logistics-map.vercel.app";
import crypto from "crypto";

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// Простой “секрет” для стабильного рандома (добавь в env)
function getSeedSecret() {
  return process.env.AUTO_SEED_SECRET || "change-me";
}

function fmtDatePartsInTz(date, timeZone) {
  // Возвращает { dd, mm, yyyy, hh, min }
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    dd: map.day,
    mm: map.month,
    yyyy: map.year,
    hh: map.hour,
    min: map.minute,
  };
}

function contractNoFromDate(date, timeZone) {
  const { dd, mm, yyyy, hh, min } = fmtDatePartsInTz(date, timeZone);
  return `${dd}${mm}${yyyy}${hh}${min}`;
}

function localDateKey(date, timeZone) {
  const { dd, mm, yyyy } = fmtDatePartsInTz(date, timeZone);
  // YYYY-MM-DD for log
  return `${yyyy}-${mm}-${dd}`;
}

function seededInt(seedStr, maxExclusive) {
  const hash = crypto.createHash("sha256").update(seedStr).digest();
  // берём первые 4 байта
  const n = hash.readUInt32BE(0);
  return n % maxExclusive;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

export default async function handler(req, res) {
  return res.status(200).json({ ok: true, ping: "daily-auto", ts: Date.now() });
}
  // Можно закрыть от внешних вызовов (не обязательно, но полезно)
  // Если хочешь — добавь env CRON_SECRET и проверяй заголовок.
  const db = supabase();

  // 1) Берём настройки
  const { data: settings, error: sErr } = await db
    .from("auto_gen_settings")
    .select("enabled,start_hub_ids,border_hub_id,brands_models,timezone")
    .eq("id", 1)
    .limit(1);

  if (sErr) return res.status(500).json({ error: sErr.message });
  const cfg = settings?.[0];
  if (!cfg?.enabled) return res.status(200).json({ ok: true, skipped: "disabled" });

  const timeZone = cfg.timezone || "Europe/Moscow";
  const now = new Date();
  const runDate = localDateKey(now, timeZone); // YYYY-MM-DD (локально)

  if (!Array.isArray(cfg.start_hub_ids) || cfg.start_hub_ids.length < 1) {
    return res.status(500).json({ error: "auto_gen_settings.start_hub_ids is empty" });
  }
  if (!cfg.border_hub_id) {
    return res.status(500).json({ error: "auto_gen_settings.border_hub_id is null" });
  }
  if (!Array.isArray(cfg.brands_models) || cfg.brands_models.length < 1) {
    return res.status(500).json({ error: "auto_gen_settings.brands_models is empty" });
  }

  // 2) Проверяем лог на сегодня
  const { data: logRows, error: lErr } = await db
    .from("auto_gen_log")
    .select("run_date,planned_at,executed_at,car_id")
    .eq("run_date", runDate)
    .limit(1);

  if (lErr) return res.status(500).json({ error: lErr.message });

  let log = logRows?.[0] || null;

  // 3) Если плана на сегодня нет — создаём planned_at (стабильный рандом на день)
  if (!log) {
    // 10:00..20:00 => 600 минут окно
    // baseTime: сегодня 10:00 по TZ (делаем через parts)
    const { dd, mm, yyyy } = fmtDatePartsInTz(now, timeZone);
    // ВАЖНО: Date в JS без TZ, поэтому планируем так:
    // Берём "сегодня" в TZ как строку и создаём дату через UTC-компоненты
    // Упрощение: planned_at будет храниться как timestamptz, это ок.
    const tenAMLocalStr = `${yyyy}-${mm}-${dd}T10:00:00`;
    // Интерпретация как “локальная” на сервере может отличаться, но нам главное сравнение now>=planned_at.
    // Чтобы не зависеть от TZ сервера — делаем planned_at как now + offset минут внутри окна
    // Но нам нужен привязанный к дню момент. Поэтому рассчитываем минуту и “приклеиваем” к локальному дню через Intl:
    const minuteOfWindow = seededInt(`${runDate}|${getSeedSecret()}`, 600); // 0..599
    // planned_at = текущий момент, но “на сегодня” — проще: берём start of today window из now в TZ:
    // Мы сделаем planned_at как "сегодня в TZ 10:00" через Date.parse(tenAMLocalStr) + minuteOfWindow.
    // На практике для МСК на Vercel работает стабильно.
    const plannedBase = new Date(Date.parse(tenAMLocalStr));
    const plannedAt = addMinutes(plannedBase, minuteOfWindow);

    const { data: inserted, error: iErr } = await db
      .from("auto_gen_log")
      .insert({ run_date: runDate, planned_at: plannedAt.toISOString() })
      .select("run_date,planned_at,executed_at,car_id")
      .limit(1);

    if (iErr) return res.status(500).json({ error: iErr.message });
    log = inserted?.[0] || null;
  }

  // 4) Если уже выполнено — выходим
  if (log.executed_at) {
    return res.status(200).json({ ok: true, skipped: "already-executed", run_date: runDate, car_id: log.car_id });
  }

  // 5) Если ещё не время — выходим
  const plannedAtMs = Date.parse(log.planned_at);
  if (Number.isNaN(plannedAtMs)) return res.status(500).json({ error: "bad planned_at in log" });

  if (now.getTime() < plannedAtMs) {
    return res.status(200).json({ ok: true, skipped: "too-early", run_date: runDate, planned_at: log.planned_at });
  }

  // 6) Пора создавать авто. Выбираем стартовый хаб + марку/модель детерминированно для дня
  const startIdx = seededInt(`${runDate}|start|${getSeedSecret()}`, cfg.start_hub_ids.length);
  const bmIdx = seededInt(`${runDate}|bm|${getSeedSecret()}`, cfg.brands_models.length);

  const startHubId = cfg.start_hub_ids[startIdx];
  const borderHubId = cfg.border_hub_id;

  const bm = String(cfg.brands_models[bmIdx] || "").trim();
  const [brandRaw, modelRaw] = bm.split("|");
  const brand = (brandRaw || "Auto").trim();
  const model = (modelRaw || "Generated").trim();

  const start_time = new Date().toISOString();
  const contract_no = contractNoFromDate(new Date(), timeZone);

  // VIN для автогенерации можно хранить заглушкой (не светится в публичке)
  const vin = `AUTO${contract_no}`;

// строим маршрут автоматически через тот же алгоритм, что у менеджера
  const suggestResp = await fetch(
    process.env.BASE_URL + `/api/admin/route_suggest?start=${startHubId}&end=${borderHubId}`
  );

  const suggestData = await suggestResp.json();

  if (!suggestResp.ok) {
    throw new Error("route suggest failed: " + suggestData.error);
  }

  const payload = {
    vin,
    contract_no,
    brand,
    model,
    photo_url: "",
    public: true,
    urgency: "std",
    start_time,
    route_hub_ids: suggestData.route_hub_ids, // ← ВОТ ЭТО ГЛАВНОЕ ИЗМЕНЕНИЕ
    is_deleted: false,
  };


  const { data: carIns, error: cErr } = await db
    .from("cars")
    .insert(payload)
    .select("id")
    .limit(1);

  if (cErr) return res.status(500).json({ error: cErr.message });

  const carId = carIns?.[0]?.id || null;

  const { error: uErr } = await db
    .from("auto_gen_log")
    .update({ executed_at: new Date().toISOString(), car_id: carId })
    .eq("run_date", runDate);

  if (uErr) return res.status(500).json({ error: uErr.message });

  return res.status(200).json({ ok: true, created: true, run_date: runDate, car_id: carId, contract_no });
}
