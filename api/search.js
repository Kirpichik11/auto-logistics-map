import { createClient } from "@supabase/supabase-js";

const KM_PER_DAY = Number(process.env.KM_PER_DAY || 550);
const FAST_FACTOR = Number(process.env.FAST_FACTOR || 0.75);
const HIDE_AFTER_DAYS = Number(process.env.HIDE_AFTER_DAYS || 3);

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function lerpLatLng(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function factorForUrgency(urgency) { return urgency === "fast" ? FAST_FACTOR : 1.0; }

function buildTimeline(route, startMs, urgency) {
  const factor = factorForUrgency(urgency);
  const dayMs = 86400_000;

  let t = startMs;
  const stages = [];

  for (let i = 0; i < route.length; i++) {
    const hub = route[i];
    const dwell = Number(hub.dwell_days || 0) * factor;

    stages.push({
      type: "dwell",
      title: `Операции: ${hub.name_ru}`,
      startMs: t,
      endMs: t + dwell * dayMs,
      at: hub,
    });

    t += dwell * dayMs;

    if (i < route.length - 1) {
      const a = route[i], b = route[i + 1];
      const distKm = haversineKm(a, b);
      const travelDays = (distKm / KM_PER_DAY) * factor;

      stages.push({
        type: "transport",
        title: `${a.name_ru} → ${b.name_ru}`,
        startMs: t,
        endMs: t + travelDays * dayMs,
        from: a, to: b,
      });

      t += travelDays * dayMs;
    }
  }

  return { stages, arriveMs: t };
}

function computePosition(stages, nowMs) {
  const current = stages.find(s => nowMs >= s.startMs && nowMs < s.endMs) || null;

  if (current?.type === "transport") {
    const prog = (nowMs - current.startMs) / (current.endMs - current.startMs);
    const t = clamp01(prog);
    return { pos: lerpLatLng(current.from, current.to, t), status: current.title };
  }

  if (current?.type === "dwell") {
    return { pos: { lat: current.at.lat, lng: current.at.lng }, status: current.title };
  }

  const last = stages[stages.length - 1];
  if (last?.type === "dwell") return { pos: { lat: last.at.lat, lng: last.at.lng }, status: "Прибыло" };
  if (last?.type === "transport") return { pos: { lat: last.to.lat, lng: last.to.lng }, status: "Прибыло" };

  return { pos: null, status: "—" };
}

function computeProgress(startMs, arriveMs, nowMs) {
  const total = arriveMs - startMs;
  if (!total || total <= 0) return 0;
  return clamp01((nowMs - startMs) / total);
}

async function tryContractSearch(db, contract, columnsToTry) {
  for (const col of columnsToTry) {
    const { data, error } = await db
      .from("cars")
      .select("id,brand,model,photo_url,urgency,start_time,route_hub_ids,is_deleted")
      .eq(col, contract)
      .eq("is_deleted", false)
      .limit(1);

    // если колонки нет — пробуем следующую
    if (error && String(error.message || "").toLowerCase().includes("does not exist")) continue;
    if (error) throw error;

    if (data && data.length) return data[0];
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  try {
    const q = String(req.query.q || "").trim();

    if (!q || q.length < 6) {
      return res.status(400).json({ error: "Введите минимум 6 символов VIN или договора" });
    }

    const db = supabase();

    const { data: hubs, error: hubsErr } = await db
      .from("hubs")
      .select("id,name_ru,country,lat,lng,dwell_days,type");
    if (hubsErr) return res.status(500).json({ error: hubsErr.message });

    const hubsById = new Map((hubs || []).map(h => [h.id, h]));

    const vin = q.toUpperCase();
    const contract = q;

    let car = null;

    // 1) VIN exact
    {
      const { data, error } = await db
        .from("cars")
        .select("id,brand,model,photo_url,urgency,start_time,route_hub_ids,is_deleted")
        .eq("vin", vin)
        .eq("is_deleted", false)
        .limit(1);

      if (error) return res.status(500).json({ error: error.message });
      if (data && data.length) car = data[0];
    }

    // 2) Contract exact (пробуем разные имена поля)
    if (!car) {
      car = await tryContractSearch(db, contract, ["contract_no", "contract", "contract_number"]);
    }

    if (!car) return res.status(404).json({ error: "Автомобиль не найден" });

    const nowMs = Date.now();
    const startMs = Date.parse(car.start_time);
    const routeIds = car.route_hub_ids || [];
    const route = routeIds.map(id => hubsById.get(id)).filter(Boolean);

    if (!startMs || route.length < 2) {
      return res.status(500).json({ error: "Маршрут/старт заданы некорректно" });
    }

    const { stages, arriveMs } = buildTimeline(route, startMs, car.urgency);
    const hideAfterMs = arriveMs + HIDE_AFTER_DAYS * 86400_000;
    if (nowMs > hideAfterMs) return res.status(404).json({ error: "Доставка завершена и скрыта" });

    const { pos, status } = computePosition(stages, nowMs);
    if (!pos) return res.status(500).json({ error: "Не удалось вычислить позицию" });

    const progress = computeProgress(startMs, arriveMs, nowMs);

    return res.status(200).json({
      car: {
        id: car.id,
        brand: car.brand || "",
        model: car.model || "",
        photo_url: car.photo_url || "",
        urgency: car.urgency,
        start_time: car.start_time,
        route_hub_ids: routeIds,
        arrive_time: new Date(arriveMs).toISOString(),
        progress,
        status,
        pos
      }
    });
  } catch (e) {
    // критично: чтобы Vercel не отдавал HTML, всегда отвечаем JSON
    return res.status(500).json({ error: "search_unhandled", details: String(e?.message || e) });
  }
}
