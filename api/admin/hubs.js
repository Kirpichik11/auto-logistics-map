import { createClient } from "@supabase/supabase-js";

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

function checkAdmin(req, res) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_PASS) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function normalizeType(t) {
  if (t === "border" || t === "office" || t === "hub") return t;
  return "hub";
}

export default async function handler(req, res) {
  if (!checkAdmin(req, res)) return;
  const db = supabase();

  if (req.method === "GET") {
    const { data, error } = await db
      .from("hubs")
      .select("id,code,name_ru,country,lat,lng,dwell_days,type,created_at")
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ hubs: data || [] });
  }

  if (req.method === "POST") {
    const { code, name_ru, country, lat, lng, dwell_days, type } = req.body || {};
    if (!code || !name_ru || !country || lat == null || lng == null) {
      return res.status(400).json({ error: "Заполните код, название, страну и координаты" });
    }

    const payload = {
      code: String(code).trim().toUpperCase(),
      name_ru: String(name_ru).trim(),
      country,
      lat: Number(lat),
      lng: Number(lng),
      dwell_days: Number(dwell_days ?? 0.5),
      type: normalizeType(type),
    };

    const { data, error } = await db.from("hubs").insert([payload]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ hub: data });
  }

  if (req.method === "PATCH") {
    const { id, code, name_ru, country, lat, lng, dwell_days, type } = req.body || {};
    if (!id) return res.status(400).json({ error: "Нет id" });

    const patch = {};
    if (code != null) patch.code = String(code).trim().toUpperCase();
    if (name_ru != null) patch.name_ru = String(name_ru).trim();
    if (country != null) patch.country = country;
    if (lat != null) patch.lat = Number(lat);
    if (lng != null) patch.lng = Number(lng);
    if (dwell_days != null) patch.dwell_days = Number(dwell_days);
    if (type != null) patch.type = normalizeType(type);

    const { data, error } = await db.from("hubs").update(patch).eq("id", id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ hub: data });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

