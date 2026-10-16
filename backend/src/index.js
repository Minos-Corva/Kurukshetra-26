import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) env vars");
  process.exit(1);
}

export const supabase = createClient(supabaseUrl, supabaseKey);

app.get("/", (_req, res) => {
  res.json({ name: "W-PS-2 AI Career Coach", status: "ok" });
});

app.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("job_postings").select("count", { head: true });
    if (error) throw error;
    res.json({ status: "ok", database: "reachable" });
  } catch (err) {
    res.status(500).json({ status: "degraded", database: "unreachable", error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

export default app;
