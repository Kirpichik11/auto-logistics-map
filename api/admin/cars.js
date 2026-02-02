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
    const q = String(req.query.q || "").trim();

    let query = db
      .from("cars")
      .select("id,vin,contract_no,brand,model,public,urgency,start_time,route_hub_ids,is_deleted,created_at")
      .order("created_at", { ascending: false })
      .limit(200);

    if (q) query = query.or(`vin.ilike.%${q}%,contract_no.ilike.%${q}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ cars: data || [] });
  }

  if (req.method === "POST") {
    const {
      vin, contract_no,
      brand, model, photo_url,
      urgency, start_time, route_hub_ids,
      public: isPublic
    } = req.body || {};

    if (!vin || !contract_no || !start_time || !Array.isArray(route_hub_ids) || route_hub_ids.length < 2) {
      return res.status(400).json({ error: "Нужны VIN, договор, старт, маршрут (мин 2 точки)" });
    }

    const payload = {
      vin: String(vin).trim().toUpperCase(),
      contract_no: String(contract_no).trim(),
      brand: brand ? String(brand).trim() : null,
      model: model ? String(model).trim() : null,
      photo_url: photo_url ? String(photo_url).trim() : null,
      urgency: urgency === "fast" ? "fast" : "std",
      start_time,
      route_hub_ids,
      public: Boolean(isPublic ?? true),
    };

    const { data, error } = await db.from("cars").insert([payload]).select().single();
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ car: data });
  }

  if (req.method === "PATCH") {
    const { id, is_deleted, public: isPublic } = req.body || {};
    if (!id) return res.status(400).json({ error: "Нет id" });

    const patch = {};
    if (typeof is_deleted === "boolean") patch.is_deleted = is_deleted;
    if (typeof isPublic === "boolean") patch.public = isPublic;

    const { data, error } = await db.from("cars").update(patch).eq("id", id).select().single();
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ car: data });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
