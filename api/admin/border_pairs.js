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

function normalizeMode(mode) {
  return mode === "sea" ? "sea" : "land";
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
    if (req.method === "GET") {
      const onlyActive = String(req.query.active || "").trim();
      let q = db
        .from("border_pairs")
        .select("id,name,mode,cn_hub_id,ru_hub_id,cn_waypoint_ids,is_active,created_at")
        .order("created_at", { ascending: false });

      if (onlyActive === "true") q = q.eq("is_active", true);

      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json({ border_pairs: data || [] });
    }

    if (req.method === "POST") {
      const body = req.body || {};

      const payload = {
        name: String(body.name || "").trim(),
        mode: normalizeMode(body.mode),
        cn_hub_id: body.cn_hub_id,
        ru_hub_id: body.ru_hub_id,
        cn_waypoint_ids: normalizeUuidArray(body.cn_waypoint_ids),
        is_active: body.is_active !== undefined ? !!body.is_active : true,
      };

      if (!payload.name) return res.status(400).json({ error: "name is required" });
      if (!payload.cn_hub_id) return res.status(400).json({ error: "cn_hub_id is required" });
      if (!payload.ru_hub_id) return res.status(400).json({ error: "ru_hub_id is required" });

      const { data, error } = await db
        .from("border_pairs")
        .insert(payload)
        .select("id,name,mode,cn_hub_id,ru_hub_id,cn_waypoint_ids,is_active,created_at")
        .limit(1);

      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json({ border_pair: data?.[0] || null });
    }

    if (req.method === "PATCH") {
      const body = req.body || {};
      const id = body.id;
      if (!id) return res.status(400).json({ error: "id is required" });

      const patch = {};
      if (body.name !== undefined) patch.name = String(body.name || "").trim();
      if (body.mode !== undefined) patch.mode = normalizeMode(body.mode);
      if (body.cn_hub_id !== undefined) patch.cn_hub_id = body.cn_hub_id;
      if (body.ru_hub_id !== undefined) patch.ru_hub_id = body.ru_hub_id;
      if (body.cn_waypoint_ids !== undefined) patch.cn_waypoint_ids = normalizeUuidArray(body.cn_waypoint_ids);
      if (body.is_active !== undefined) patch.is_active = !!body.is_active;

      if (patch.name !== undefined && !patch.name) {
        return res.status(400).json({ error: "name cannot be empty" });
      }

      const { data, error } = await db
        .from("border_pairs")
        .update(patch)
        .eq("id", id)
        .select("id,name,mode,cn_hub_id,ru_hub_id,cn_waypoint_ids,is_active,created_at")
        .limit(1);

      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json({ border_pair: data?.[0] || null });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
