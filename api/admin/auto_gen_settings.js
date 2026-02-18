
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

function normalizeBrandsModels(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === "string") {
    return v.split("\n").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function clampInt(x, lo, hi, def) {
  const n = Number(x);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  const db = supabase();

  try {
    if (req.method === "GET") {
      const { data, error } = await db
        .from("auto_gen_settings")
        .select("id,enabled,start_hub_ids,end_hub_ids,brands_models,timezone,window_start_hour,window_end_hour")
        .eq("id", 1)
        .limit(1);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ settings: data?.[0] || null });
    }

    if (req.method === "PATCH" || req.method === "POST") {
      const b = req.body || {};

      const patch = {
        enabled: b.enabled === undefined ? undefined : normalizeBool(b.enabled),
        start_hub_ids: b.start_hub_ids === undefined ? undefined : normalizeUuidArray(b.start_hub_ids),
        end_hub_ids: b.end_hub_ids === undefined ? undefined : normalizeUuidArray(b.end_hub_ids),
        brands_models: b.brands_models === undefined ? undefined : normalizeBrandsModels(b.brands_models),
        timezone: b.timezone === undefined ? undefined : String(b.timezone || "").trim() || "Europe/Moscow",
        window_start_hour: b.window_start_hour === undefined ? undefined : clampInt(b.window_start_hour, 0, 23, 10),
        window_end_hour: b.window_end_hour === undefined ? undefined : clampInt(b.window_end_hour, 1, 24, 20),
      };

      // убрать undefined
      for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];

      if (patch.window_start_hour !== undefined && patch.window_end_hour !== undefined) {
        if (patch.window_end_hour <= patch.window_start_hour) {
          return res.status(400).json({ error: "window_end_hour must be > window_start_hour" });
        }
      }

      const { data, error } = await db
        .from("auto_gen_settings")
        .update(patch)
        .eq("id", 1)
        .select("id,enabled,start_hub_ids,end_hub_ids,brands_models,timezone,window_start_hour,window_end_hour")
        .limit(1);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ settings: data?.[0] || null });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
