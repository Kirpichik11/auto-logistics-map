import { createClient } from "@supabase/supabase-js";

const KM_PER_DAY = Number(process.env.KM_PER_DAY || 550);

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// === ВАЖНО ===
// Ниже я предполагаю, что таблица пар границы называется border_pairs
// и поля: cn_hub_id uuid, ru_hub_id uuid, enabled boolean.
// Если у тебя имя/поля другие — скажи, и я подстрою ровно под ваши названия.
async function loadBorderPairs(db) {
  const { data, error } = await db
    .from("border_pairs")
    .select("cn_hub_id,ru_hub_id,enabled");

  if (error) throw new Error("border_pairs: " + error.message);

  return (data || []).filter(x => x.enabled !== false);
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

// расстояние от точки P до отрезка AB (приближенно, в км) через проекцию в "плоских" координатах
function pointToSegmentKm(p, a, b) {
  // грубо переводим lat/lng в метры (локально)
  const x = (lng) => lng * 111320 * Math.cos((p.lat * Math.PI) / 180);
  const y = (lat) => lat * 110540;

  const ax = x(a.lng), ay = y(a.lat);
  const bx = x(b.lng), by = y(b.lat);
  const px = x(p.lng), py = y(p.lat);

  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;

  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return haversineKm(p, a);

  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));

  const cx = ax + abx * t;
  const cy = ay + aby * t;

  const dx = px - cx;
  const dy = py - cy;

  // метры -> км
  return Math.sqrt(dx * dx + dy * dy) / 1000;
}

// выбираем “лучший” погран-переход для start->end (сухопутка)
function pickBestBorderPair(startHub, endHub, pairs, hubsById) {
  let best = null;
  let bestScore = Infinity;

  for (const p of pairs) {
    const cn = hubsById.get(p.cn_hub_id);
    const ru = hubsById.get(p.ru_hub_id);
    if (!cn || !ru) continue;

    // старт CN -> cnBorder + ruBorder -> конец RU
    const d1 = haversineKm(startHub, cn);
    const d2 = haversineKm(ru, endHub);

    const score = d1 + d2; // можно усложнять, но пока так
    if (score < bestScore) {
      bestScore = score;
      best = { cn, ru };
    }
  }
  return best; // {cn,ru} или null
}

// строим промежуточные точки по “линии” start->target
// minCount обязателен (например 3 в CN), maxCount ограничение (например 3 в RU)
function buildIntermediateLine(start, target, candidates, minCount, maxCount) {
  const chosen = [];

  // кандидат должен быть “близко к линии”, иначе игнор
  // порог можно менять: 120км для CN, 150км для RU
  const thresholdKm = 150;

  // сортируем по близости к линии + по расстоянию от старта (чтобы естественный порядок)
  const scored = candidates
    .map(h => ({
      h,
      off: pointToSegmentKm(h, start, target),
      fromStart: haversineKm(start, h),
    }))
    .filter(x => x.off <= thresholdKm)
    .sort((a, b) => (a.off - b.off) || (a.fromStart - b.fromStart));

  // если точек мало — просто возьмём ближайшие по расстоянию к линии
  for (const x of scored) {
    if (chosen.length >= maxCount) break;
    // не берём слишком близко к старту/цели (чтобы не было “шаг 5км”)
    if (haversineKm(x.h, start) < 30) continue;
    if (haversineKm(x.h, target) < 30) continue;
    chosen.push(x.h);
  }

  // гарантируем minCount: если не набрали, добиваем ближайшими к линии без threshold
  if (chosen.length < minCount) {
    const fallback = candidates
      .map(h => ({ h, off: pointToSegmentKm(h, start, target) }))
      .sort((a,b)=>a.off-b.off);

    for (const x of fallback) {
      if (chosen.length >= minCount) break;
      if (chosen.some(z => z.id === x.h.id)) continue;
      if (haversineKm(x.h, start) < 30) continue;
      if (haversineKm(x.h, target) < 30) continue;
      chosen.push(x.h);
      if (chosen.length >= maxCount) break;
    }
  }

  // упорядочим по “удалению от старта”
  chosen.sort((a,b)=>haversineKm(start,a)-haversineKm(start,b));
  return chosen;
}

async function suggestRoute(db, startHubId, endHubId) {
  const { data: hubs, error: hubsErr } = await db
    .from("hubs")
    .select("id,code,name_ru,country,lat,lng,type,dwell_days");
  if (hubsErr) throw new Error(hubsErr.message);

  const hubsById = new Map((hubs || []).map(h => [h.id, h]));
  const startHub = hubsById.get(startHubId);
  const endHub = hubsById.get(endHubId);

  if (!startHub || !endHub) throw new Error("start/end hub not found");
  if (startHub.country !== "CN") throw new Error("start hub must be CN");
  if (endHub.country !== "RU") throw new Error("end hub must be RU");

  const pairs = await loadBorderPairs(db);
  if (!pairs.length) throw new Error("No border pairs configured");

  const best = pickBestBorderPair(startHub, endHub, pairs, hubsById);
  if (!best) throw new Error("No valid border pair found");

  const cnCandidates = (hubs || []).filter(h => h.country === "CN" && h.type !== "border");
  const ruCandidates = (hubs || []).filter(h => h.country === "RU" && h.type !== "border");

  // CN: минимум 3 промежуточных, максимум 6 (чтобы не раздувать)
  const cnMids = buildIntermediateLine(startHub, best.cn, cnCandidates, 3, 6);

  // RU: максимум 3 промежуточных, минимум 0
  const ruMids = buildIntermediateLine(best.ru, endHub, ruCandidates, 0, 3);

  const route = [
    startHub,
    ...cnMids,
    best.cn,      // CN border
    best.ru,      // RU border (смежный город)
    ...ruMids,
    endHub,
  ];

  // Убираем дубли на всякий
  const uniq = [];
  const seen = new Set();
  for (const h of route) {
    if (!h?.id) continue;
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    uniq.push(h);
  }

  if (uniq.length < 2) throw new Error("Route too short");
  return uniq.map(h => h.id);
}

export default async function handler(req, res) {
  const startId = String(req.query.start || "").trim();
  const endId = String(req.query.end || "").trim();
  if (!startId || !endId) return res.status(400).json({ error: "start and end required" });

  try {
    const db = supabase();
    const route_hub_ids = await suggestRoute(db, startId, endId);
    return res.status(200).json({ route_hub_ids });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "suggest failed" });
  }
}
