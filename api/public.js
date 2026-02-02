export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

  if (!AIRTABLE_BASE_ID || !AIRTABLE_TOKEN) {
    return res.status(500).json({ error: "Airtable env not set" });
  }

  try {
    // Load Hubs
    const hubsResp = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Hubs?maxRecords=500`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    const hubsJson = await hubsResp.json();

    // Load Cars (only public)
    const carsResp = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Cars?maxRecords=500&filterByFormula=${encodeURIComponent("{public}=TRUE()")}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    const carsJson = await carsResp.json();

    const hubs = hubsJson.records.map(r => ({
      id: r.id,
      code: r.fields.code,
      name: r.fields.name,
      lat: r.fields.lat,
      lng: r.fields.lng
    }));

    const link = v => Array.isArray(v) ? v[0] : null;

    const cars = carsJson.records.map(r => ({
      id: r.id,
      brand: r.fields.brand || "",
      model: r.fields.model || "",
      photo_url: r.fields.photo_url || "",
      start_time: r.fields.start_time || null,
      km_per_day: Number(r.fields.km_per_day || 600),

      doc_days_1: Number(r.fields.doc_days_1 || 2),
      loading_days: Number(r.fields.loading_days || 1),
      transshipment_days: Number(r.fields.transshipment_days || 0.5),
      export_doc_days: Number(r.fields.export_doc_days || 1),

      start_hub: link(r.fields.start_hub),
      mid1_hub: link(r.fields.mid1_hub),
      mid2_hub: link(r.fields.mid2_hub),
      end_hub: link(r.fields.end_hub),

      notes: r.fields.notes || ""
    }));

    res.status(200).json({ hubs, cars });
  } catch (e) {
    res.status(500).json({ error: "Failed to load data" });
  }
}
