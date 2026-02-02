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
      .from("route_templates")
      .select("id,name,hub_ids,created_at")
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ routes: data || [] });
  }

  if (req.method === "POST") {
    const { name, hub_ids } = req.body || {};
    if (!name || !Array.isArray(hub_ids) || hub_ids.length < 2) {
      return res.status(400).json({ error: "Нужно название и минимум 2 хаба РФ" });
    }

    const { data, error } = await db
      .from("route_templates")
      .insert([{ name: String(name).trim(), hub_ids }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ route: data });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
