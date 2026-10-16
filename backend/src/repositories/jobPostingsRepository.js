export class JobPostingsRepository {
  constructor({ supabaseClient } = {}) {
    if (!supabaseClient) {
      throw new Error("supabaseClient is required");
    }
    this.supabase = supabaseClient;
  }

  async createPosting({ sourceUrl, rawText }) {
    const { data, error } = await this.supabase
      .from("job_postings")
      .insert({ source_url: sourceUrl, raw_text: rawText })
      .select("id, source_url, raw_text, fetched_at, created_at")
      .single();

    if (error) throw error;
    return data;
  }

  async createRequirements(postingId, requirements) {
    // Deduplicate by requirement_key, keeping first occurrence
    const seen = new Set();
    const uniqueRequirements = [];
    for (const req of requirements) {
      if (seen.has(req.requirement_key)) continue;
      seen.add(req.requirement_key);
      uniqueRequirements.push(req);
    }

    if (uniqueRequirements.length === 0) {
      return [];
    }

    const rows = uniqueRequirements.map((req, index) => ({
      job_posting_id: postingId,
      requirement_key: req.requirement_key,
      skill: req.skill,
      description: req.description,
      evidence_hints: req.evidence_hints || [],
      source_excerpt: req.source_excerpt,
      sort_order: index,
    }));

    const { data, error } = await this.supabase
      .from("requirements")
      .insert(rows)
      .select();

    if (error) throw error;
    return data;
  }
}
