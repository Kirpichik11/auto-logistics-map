import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const config = {
  runtime: "nodejs", // важно: чтобы не было edge-ошибок с crypto и т.п.
};

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// --- utils ---
function pad2(n) {
  return String(n).padStart(2, "0");
}

// ddMMyyyyHHmm (UTC — но главное уникальность; ниже есть ретраи)
function makeContractNoBase(d) {
  const dd = pad2(d.getUTCDate());
  const mm = pad2(d.getUTCMonth() + 1);
  const yyyy = String(d.getUTCFullYear());
  const HH = pad2(d.getUTCHours());
  const MM = pad2(d.getUTCMinutes());
  return `${dd}${mm}${yyyy}${HH}${MM}`;
}

// случайное время сегодня в окне часов (по UTC; можно потом привязать к Москве)
function randomStartTimeTodayUTC(windowStartHour = 10, windowEndHour = 20) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), windowStartHour, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), windowEndHour, 0, 0));
  const a = start.getTime();
  const b = end.getTime();
  const t = a + Math.floor(Math.random() * Math.max(1, (b - a)));
  return new Date(t);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function contractExists(db, contractNo) {
  const { data, error } = await db
    .from("cars")
    .select("id")
    .eq("contract_no", contractNo)
    .eq("is_deleted", false)
    .limit(1);

  if (error) throw new Error("contractExists: " + error.message);
  return Array.isArray(data) && data.length > 0;
}

async function ensureUniqueContractNo(db, base, maxTries = 20) {
  // 1) пробуем base
  if (!(await contractExists(db, base))) return base;

  // 2) добиваем суффиксом
  for (let i = 0; i < maxTries; i++) {
    const suffix = pad2(Math.floor(Math.random() * 100)); // 00..99
    const candidate = base + suffix;
    if (!(await contractExists(db, candidate))) return candidate;
  }
  throw new Error("Не удалось подобрать уникальный contract_no (слишком много коллизий)");
}

async function loadAutoGenSettings(db) {
  // предполагаем 1 строку в auto_gen_settings
  const { data, error } = await db
    .from("auto_gen_settings")
    .select("*")
    .limit(1);

  if (error) throw new Error("auto_gen_settings: " + error.message);
  return (data && data[0]) || null;
}

// защита от повторного запуска в один день
async function alreadyRanToday(db) {
  const today = new Date();
  const dayKey = `${today.getUTCFullYear()}-${pad2(today.getUTCMonth() + 1)}-${pad2(today.getUTCDate())}`;

  const { data, error } = await db
    .from("auto_gen_log")
    .select("id,status")
    .eq("day_key", dayKey)
    .limit(1);

  if (error) {
    // если таблица/поле не так — просто не блокируем, но логируем
    console.warn("auto_gen_log read warn:", error.message);
    return { dayKey, exists: false };
  }

  if (data && data.length && data[0].status === "success") {
    return { dayKey, exists: true };
  }

  return { dayKey, exists: false };
}

async function writeLog(db, dayKey, status, details) {
  // ожидаем поля: day_key text UNIQUE, status text, details jsonb, created_at timestamptz default now()
  const { error } = await db
    .from("auto_gen_log")
    .upsert([{ day_key: dayKey, status, details }], { onConflict: "day_key" });

  if (error) console.warn("auto_gen_log upsert warn:", error.message);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    const db = supabase();

    const settings = await loadAutoGenSettings(db);
    if (!settings || settings.enabled === false) {
      return res.status(200).json({ ok: true, skipped: true, reason: "autogen disabled" });
    }

    // защита от повторного запуска
    const { dayKey, exists } = await alreadyRanToday(db);
    if (exists) {
      return res.status(200).json({ ok: true, skipped: true, reason: "already ran today", dayKey });
    }

    const startHubIds = Array.isArray(settings.start_hub_ids) ? settings.start_hub_ids : [];
    const endHubIds = Array.isArray(settings.end_hub_ids) ? settings.end_hub_ids : [];
    const brandsModels = Array.isArray(settings.brands_models) ? settings.brands_models : [];

    if (!startHubIds.length || !endHubIds.length || !brandsModels.length) {
      await writeLog(db, dayKey, "error", { msg: "settings invalid", startHubIds: startHubIds.length, endHubIds: endHubIds.length, brandsModels: brandsModels.length });
      return res.status(500).json({ error: "auto_gen_settings пустые (нужны start/end/brands_models)" });
    }

    const startHubId = pickRandom(startHubIds);
    const endHubId = pickRandom(endHubIds);

    const bm = pickRandom(brandsModels);
    const [brandRaw, modelRaw] = String(bm).split("|");
    const brand = (brandRaw || "").trim() || "Auto";
    const model = (modelRaw || "").trim() || "Model";

    const windowStartHour = Number(settings.window_start_hour ?? 10);
    const windowEndHour = Number(settings.window_end_hour ?? 20);
    const startTime = randomStartTimeTodayUTC(windowStartHour, windowEndHour);

    const baseContractNo = makeContractNoBase(startTime);
    const contract_no = await ensureUniqueContractNo(db, baseContractNo);

    const vin = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex")).toUpperCase();

    // ВАЖНО: cron НЕ должен дублировать алгоритм маршрута.
    // Мы вызываем централизованный маршрутный эндпоинт route_suggest
    // (он у тебя: /api/admin/route_suggest.js)
    // Он использует service_role через Supabase и ему не нужен adminKey.
    const routeResp = await fetch(
      `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : ""}/api/admin/route_suggest?start=${encodeURIComponent(startHubId)}&end=${encodeURIComponent(endHubId)}`,
      { method: "GET" }
    );

    const routeData = await routeResp.json().catch(() => ({}));
    if (!routeResp.ok || !routeData.route_hub_ids) {
      await writeLog(db, dayKey, "error", { msg: "route_suggest failed", status: routeResp.status, routeData });
      return res.status(500).json({ error: "route_suggest failed", details: routeData });
    }

    const route_hub_ids = routeData.route_hub_ids;

    const { error: insErr } = await db
      .from("cars")
      .insert([{
        vin,
        contract_no,
        brand,
        model,
        photo_url: "",
        urgency: "std",
        start_time: startTime.toISOString(),
        route_hub_ids,
        public: true,
        is_deleted: false
      }]);

    if (insErr) {
      await writeLog(db, dayKey, "error", { msg: "cars insert failed", error: insErr.message });
      return res.status(500).json({ error: insErr.message });
    }

    await writeLog(db, dayKey, "success", { contract_no, vin, startHubId, endHubId });

    return res.status(200).json({
      ok: true,
      created: true,
      contract_no,
      vin,
      start_time: startTime.toISOString(),
      startHubId,
      endHubId
    });

  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}


