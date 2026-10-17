/**
 * assessmentRepository.js
 *
 * Supabase persistence for Feature 7 (requirement-by-requirement assessment):
 * - look up an existing assessment for a (job posting, repository, commit SHA) triple
 * - insert the assessment plus per-requirement verdicts and evidence citations
 * - read a full assessment (verdicts + citations) back out
 *
 * The API/LLM vocabulary is `supported | partial | not_found`, but the pre-applied
 * `requirement_assessments_status_check` constraint only permits
 * `demonstrated | partial | not_demonstrated | uncertain`. This module is the single
 * place where the two vocabularies are mapped, so the schema is never changed.
 */

const DB_STATUS_BY_API = {
  supported: "demonstrated",
  partial: "partial",
  not_found: "not_demonstrated",
};

const API_STATUS_BY_DB = {
  demonstrated: "supported",
  partial: "partial",
  not_demonstrated: "not_found",
  uncertain: "uncertain",
};

/** Map an API/LLM status to the value stored in `requirement_assessments.status`. */
export function apiStatusToDb(status) {
  return DB_STATUS_BY_API[status] || null;
}

/**
 * Map a persisted status back to the API vocabulary. `uncertain` is passed
 * through defensively in case a row was written by another process; the LLM only
 * ever produces the three primary statuses.
 */
export function dbStatusToApi(status) {
  return API_STATUS_BY_DB[status] ?? "not_found";
}

export class AssessmentRepository {
  /**
   * @param {object} options
   * @param {import('@supabase/supabase-js').SupabaseClient} options.supabaseClient
   */
  constructor({ supabaseClient } = {}) {
    if (!supabaseClient) {
      throw new Error("supabaseClient is required");
    }
    this.supabase = supabaseClient;
  }

  /**
   * Find an existing assessment for the same (job posting, repository, commit SHA).
   * Used to keep repeated requests idempotent (a new commit SHA yields a new row).
   *
   * @param {object} params
   * @param {string} params.jobPostingId
   * @param {string} params.repositoryId
   * @param {string} params.commitSha
   * @returns {Promise<object|null>}
   */
  async findExistingAssessment({ jobPostingId, repositoryId, commitSha }) {
    const { data, error } = await this.supabase
      .from("assessments")
      .select("id, job_posting_id, repository_id, commit_sha, model_name, created_at")
      .eq("job_posting_id", jobPostingId)
      .eq("repository_id", repositoryId)
      .eq("commit_sha", commitSha)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to look up existing assessment: ${error.message}`);
    }
    return data;
  }

  /**
   * Insert a new assessment row.
   */
  async createAssessment({ jobPostingId, repositoryId, commitSha, modelName }) {
    const { data, error } = await this.supabase
      .from("assessments")
      .insert({
        job_posting_id: jobPostingId,
        repository_id: repositoryId,
        commit_sha: commitSha,
        model_name: modelName,
      })
      .select("id, job_posting_id, repository_id, commit_sha, model_name, created_at")
      .single();

    if (error) {
      throw new Error(`Failed to create assessment: ${error.message}`);
    }
    return data;
  }

  /**
   * Persist per-requirement verdicts and their evidence citations.
   *
   * @param {object} params
   * @param {string} params.assessmentId
   * @param {Array<object>} params.results Each result carries requirementId, api status,
   *   explanation, confidence and resolved evidence items.
   * @returns {Promise<number>} number of verdict rows written
   */
  async saveResults({ assessmentId, results }) {
    if (results.length === 0) return 0;

    const verdictRows = results.map((result) => ({
      assessment_id: assessmentId,
      requirement_id: result.requirementId,
      status: apiStatusToDb(result.status),
      explanation: result.explanation,
      confidence: result.confidence ?? null,
    }));

    const { data: inserted, error } = await this.supabase
      .from("requirement_assessments")
      .insert(verdictRows)
      .select("id, requirement_id");

    if (error) {
      throw new Error(`Failed to save requirement assessments: ${error.message}`);
    }

    const idByRequirement = new Map((inserted || []).map((row) => [row.requirement_id, row.id]));

    const evidenceRows = [];
    for (const result of results) {
      const requirementAssessmentId = idByRequirement.get(result.requirementId);
      if (!requirementAssessmentId) continue;

      for (const item of result.evidence) {
        // assessment_evidence enforces NOT NULL on file_path / commit_sha / source_url.
        if (!item.filePath || !item.sourceUrl || !result.commitSha) continue;
        evidenceRows.push({
          requirement_assessment_id: requirementAssessmentId,
          code_chunk_id: item.chunkId ?? null,
          file_path: item.filePath,
          start_line: item.startLine ?? null,
          end_line: item.endLine ?? null,
          commit_sha: result.commitSha,
          quote: item.quote ?? null,
          source_url: item.sourceUrl,
        });
      }
    }

    if (evidenceRows.length > 0) {
      const { error: evidenceError } = await this.supabase
        .from("assessment_evidence")
        .insert(evidenceRows);

      if (evidenceError) {
        throw new Error(`Failed to save assessment evidence: ${evidenceError.message}`);
      }
    }

    return (inserted || []).length;
  }

  /**
   * Load an assessment and its stored verdicts + evidence citations.
   *
   * @param {string} assessmentId
   * @returns {Promise<{assessment: object, verdicts: Array<object>, evidence: Array<object>}|null>}
   */
  async getAssessmentById(assessmentId) {
    const { data: assessment, error } = await this.supabase
      .from("assessments")
      .select("id, job_posting_id, repository_id, commit_sha, model_name, created_at")
      .eq("id", assessmentId)
      .maybeSingle();

    if (error) throw new Error(`Failed to load assessment: ${error.message}`);
    if (!assessment) return null;

    const { data: verdicts, error: verdictError } = await this.supabase
      .from("requirement_assessments")
      .select("id, requirement_id, status, explanation, confidence")
      .eq("assessment_id", assessmentId);

    if (verdictError) throw new Error(`Failed to load requirement assessments: ${verdictError.message}`);

    const verdictIds = (verdicts || []).map((v) => v.id);
    let evidence = [];
    if (verdictIds.length > 0) {
      const { data, error: evidenceError } = await this.supabase
        .from("assessment_evidence")
        .select(
          "id, requirement_assessment_id, code_chunk_id, file_path, start_line, end_line, commit_sha, quote, source_url"
        )
        .in("requirement_assessment_id", verdictIds);

      if (evidenceError) throw new Error(`Failed to load assessment evidence: ${evidenceError.message}`);
      evidence = data || [];
    }

    return { assessment, verdicts: verdicts || [], evidence };
  }

  /**
   * Fetch requirements for a posting (used when reading a stored assessment back).
   */
  async getRequirementsByPostingId(postingId) {
    const { data, error } = await this.supabase
      .from("requirements")
      .select("id, job_posting_id, requirement_key, skill, description, evidence_hints, source_excerpt, sort_order")
      .eq("job_posting_id", postingId)
      .order("sort_order", { ascending: true });

    if (error) throw new Error(`Failed to load requirements: ${error.message}`);
    return data || [];
  }

  /**
   * Fetch repository metadata (used when reading a stored assessment back).
   */
  async getRepositoryById(id) {
    const { data, error } = await this.supabase
      .from("repositories")
      .select("id, owner, name, full_name, html_url, default_branch")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(`Failed to load repository: ${error.message}`);
    return data;
  }
}
