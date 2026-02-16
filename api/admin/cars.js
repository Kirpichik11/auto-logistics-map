import { createClient } from "@supabase/supabase-js";

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

function requireAdmin(req, res) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_PASS) {
    res.status(500).json({ error: "ADMIN_PASS is not set" });
    return false;
  }
  if (!key || key !== process.env.ADMIN_PASS) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function normalizeUrgency(u) {
  return u === "fast" ? "fast" : "std";
}

function normalizeBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return false;
}

function normalizeUuidArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return [];
}

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;

  const db = supabase();

  try {
    // ===========================
    // GET: список/поиск/по id
    // ===========================
    if (req.method === "GET") {
      const id = String(req.query.id || "").trim();
      const q = String(req.query.q || "").trim();

      // 1) получить по id (для клика по маркеру на карте)
      if (id) {
        const { data, error } = await db
          .from("cars")
          .select("id,vin,contract_no,brand,model,photo_url,public,urgency,start_time,route_hub_ids,is_deleted,created_at")
          .eq("id", id)
          .limit(1);

        if (error) return res.status(500).json({ error: error.message });
        if (!data || !data.length) return res.status(404).json({ error: "Car not found" });

        return res.status(200).json({ car: data[0] });
      }

      // 2) поиск по VIN или договору (точное совпадение)
      if (q) {
        const vin = q.toUpperCase();
        const contract = q;

        // сначала vin
        let car = null;
        {
          const { data, error } = await db
            .from("cars")
            .select("id,vin,contract_no,brand,model,photo_url,public,urgency,start_time,route_hub_ids,is_deleted,created_at")
            .eq("vin", vin)
            .limit(20);

          if (error) return res.status(500).json({ error: error.message });
          if (data?.length) car = data;
        }

        // затем договор (добавим результаты)
        let byContract = [];
        {
          const { data, error } = await db
            .from("cars")
            .select("id,vin,contract_no,brand,model,photo_url,public,urgency,start_time,route_hub_ids,is_deleted,created_at")
            .eq("contract_no", contract)
            .limit(20);

          if (error) return res.status(500).json({ error: error.message });
          byContract = data || [];
        }

        const map = new Map();
        for (const x of (car || [])) map.set(x.id, x);
        for (const x of byContract) map.set(x.id, x);

        return res.status(200).json({ cars: Array.from(map.values()) });
      }

      // 3) список последних (чтобы админка могла показывать “последние 50”)
      const { data, error } = await db
        .from("cars")
        .select("id,vin,contract_no,brand,model,photo_url,public,urgency,start_time,route_hub_ids,is_deleted,created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ cars: data || [] });
    }

    // ===========================
    // POST: создание
    // ===========================
    if (req.method === "POST") {
      const b = req.body || {};

      const payload = {
        vin: String(b.vin || "").trim().toUpperCase(),
        contract_no: String(b.contract_no || "").trim(),
        brand: String(b.brand || "").trim(),
        model: String(b.model || "").trim(),
        photo_url: String(b.photo_url || "").trim(),
        public: b.public === undefined ? true : normalizeBool(b.public),
        urgency: normalizeUrgency(b.urgency),
        start_time: b.start_time,
        route_hub_ids: normalizeUuidArray(b.route_hub_ids),
        is_deleted: false,
      };

      if (!payload.vin) return res.status(400).json({ error: "vin is required" });
      if (!payload.contract_no) return res.status(400).json({ error: "contract_no is required" });
      if (!payload.start_time) return res.status(400).json({ error: "start_time is required" });
      if (!payload.route_hub_ids || payload.route_hub_ids.length < 2) {
        return res.status(400).json({ error: "route_hub_ids must have at least 2 points" });
      }

      const { data, error } = await db
        .from("cars")
        .insert(payload)
        .select("id,vin,contract_no,brand,model,photo_url,public,urgency,start_time,route_hub_ids,is_deleted,created_at")
        .limit(1);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ car: data?.[0] || null });
    }

    // ===========================
    // PATCH: обновление/удаление
    // ===========================
    if (req.method === "PATCH") {
      const b = req.body || {};
      const id = String(b.id || "").trim();
      if (!id) return res.status(400).json({ error: "id is required" });

      const patch = {};

      if (b.vin !== undefined) patch.vin = String(b.vin || "").trim().toUpperCase();
      if (b.contract_no !== undefined) patch.contract_no = String(b.contract_no || "").trim();
      if (b.brand !== undefined) patch.brand = String(b.brand || "").trim();
      if (b.model !== undefined) patch.model = String(b.model || "").trim();
      if (b.photo_url !== undefined) patch.photo_url = String(b.photo_url || "").trim();
      if (b.public !== undefined) patch.public = normalizeBool(b.public);
      if (b.urgency !== undefined) patch.urgency = normalizeUrgency(b.urgency);
      if (b.start_time !== undefined) patch.start_time = b.start_time;
      if (b.route_hub_ids !== undefined) patch.route_hub_ids = normalizeUuidArray(b.route_hub_ids);
      if (b.is_deleted !== undefined) patch.is_deleted = normalizeBool(b.is_deleted);

      // минимальные проверки
      if (patch.vin !== undefined && !patch.vin) return res.status(400).json({ error: "vin cannot be empty" });
      if (patch.contract_no !== undefined && !patch.contract_no) return res.status(400).json({ error: "contract_no cannot be empty" });
      if (patch.route_hub_ids !== undefined && patch.route_hub_ids.length < 2) {
        return res.status(400).json({ error: "route_hub_ids must have at least 2 points" });
      }

      const { data, error } = await db
        .from("cars")
        .update(patch)
        .eq("id", id)
        .select("id,vin,contract_no,brand,model,photo_url,public,urgency,start_time,route_hub_ids,is_deleted,created_at")
        .limit(1);

      if (error) return res.status(500).json({ error: error.message });
      if (!data || !data.length) return res.status(404).json({ error: "Car not found" });

      return res.status(200).json({ car: data[0] });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
