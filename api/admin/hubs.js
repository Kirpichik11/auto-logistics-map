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

export default async function handler(req, res) {
  if (!checkAdmin(req, res)) return;

  const db = supabase();

  if (req.method === "GET") {
    const { data, error } = await db
      .from("hubs")
      .select("id,code,name_ru,country,lat,lng,dwell_days,created_at")
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ hubs: data || [] });
  }

  if (req.method === "POST") {
    const { code, name_ru, country, lat, lng, dwell_days } = req.body || {};
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
    };

    const { data, error } = await db.from("hubs").insert([payload]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ hub: data });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
