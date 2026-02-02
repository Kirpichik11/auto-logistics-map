import { createClient } from "@supabase/supabase-js";

const KM_PER_DAY = Number(process.env.KM_PER_DAY || 550);
const FAST_FACTOR = Number(process.env.FAST_FACTOR || 0.75);
const HIDE_AFTER_DAYS = Number(process.env.HIDE_AFTER_DAYS || 3);

function supabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function lerp(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

function factor(urgency) {
  return urgency === "fast" ? FAST_FACTOR : 1;
}

function buildTimeline(route, startMs, urgency) {
  const f = factor(urgency);
  const dayMs = 86400_000;
  let t = startMs;
  const stages = [];

  for (let i = 0; i < route.length; i++) {
    const hub = route[i];
    const dwell = (hub.dwell_days || 0) * f;

    stages.push({
      type: "dwell",
      startMs: t,
      endMs: t + dwell * dayMs,
      at: hub,
      title: `Операции: ${hub.name_ru}`,
    });

    t += dwell * dayMs;

    if (i < route.length - 1) {
      const a = route[i];
      const b = route[i + 1];
      const dist = haversineKm(a, b);
      const travelDays = (dist / KM_PER_DAY) * f;

      stages.push({
        type: "transport",
        startMs: t,
        endMs: t + travelDays * dayMs,
        from: a,
        to: b,
        title: `${a.name_ru} → ${b.name_ru}`,
      });

      t += travelDays * dayMs;
    }
  }

  return { stages, arriveMs: t };
}

function position(stages, now) {
  const s = stages.find(
    (x) => now >= x.startMs && now < x.endMs
  );
  if (!s) return null;

  if (s.type === "dwell") {
    return { pos: { lat: s.at.lat, lng: s.at.lng }, status: s.title };
  }

  const t = (now - s.startMs) / (s.endMs - s.startMs);
  return {
    pos: lerp(s.from, s.to, Math.max(0, Math.min(1, t))),
    status: s.title,
  };
}

export default async function handler(req, res) {
  const db = supabase();

  const { data: hubs } = await db
    .from("hubs")
    .select("id,name_ru,lat,lng,dwell_days");

  const hubMap = Object.fromEntries(hubs.map((h) => [h.id, h]));

  const { data: cars } = await db
    .from("cars")
    .select("id,brand,model,photo_url,urgency,start_time,route_hub_ids")
    .eq("public", true)
    .eq("is_deleted", false);

  const now = Date.now();
  const result = [];

  for (const c of cars) {
    const route = c.route_hub_ids.map((id) => hubMap[id]).filter(Boolean);
    if (route.length < 2) continue;

    const startMs = Date.parse(c.start_time);
    const { stages, arriveMs } = buildTimeline(route, startMs, c.urgency);

    if (now > arriveMs + HIDE_AFTER_DAYS * 86400_000) continue;

    const p = position(stages, now);
    if (!p) continue;

    result.push({
      id: c.id,
      brand: c.brand,
      model: c.model,
      photo_url: c.photo_url,
      urgency: c.urgency,
      arrive_time: new Date(arriveMs).toISOString(),
      ...p,
    });
  }

  res.status(200).json({ cars: result, hubs });
}

