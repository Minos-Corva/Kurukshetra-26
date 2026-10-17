/**
 * evidenceRepository.js
 *
 * Encapsulates Supabase database interactions for Evidence Retrieval:
 * - job_postings lookup
 * - requirements lookup
 * - assessments lookup
 * - repositories lookup (by ID or owner/name)
 * - repository_index_state & chunk count checks
 * - match_code_chunks RPC execution with vector similarity and repository scoping
 */

export class EvidenceRepository {
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
   * Fetch a job posting by UUID.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getJobPostingById(id) {
    const { data, error } = await this.supabase
      .from("job_postings")
      .select("id, source_url, raw_text, fetched_at, created_at")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to query job_postings: ${error.message}`);
    }
    return data;
  }

  /**
   * Fetch structured requirements for a job posting, ordered by sort_order.
   *
   * @param {string} postingId
   * @returns {Promise<Array<object>>}
   */
  async getRequirementsByPostingId(postingId) {
    const { data, error } = await this.supabase
      .from("requirements")
      .select("id, job_posting_id, requirement_key, skill, description, evidence_hints, source_excerpt, sort_order")
      .eq("job_posting_id", postingId)
      .order("sort_order", { ascending: true });

    if (error) {
      throw new Error(`Failed to query requirements: ${error.message}`);
    }
    return data || [];
  }

  /**
   * Fetch an assessment record by UUID.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getAssessmentById(id) {
    const { data, error } = await this.supabase
      .from("assessments")
      .select("id, job_posting_id, repository_id, commit_sha, model_name, created_at")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to query assessments: ${error.message}`);
    }
    return data;
  }

  /**
   * Fetch repository by UUID.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getRepositoryById(id) {
    const { data, error } = await this.supabase
      .from("repositories")
      .select("id, owner, name, full_name, html_url, default_branch, created_at")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to query repository by id: ${error.message}`);
    }
    return data;
  }

  /**
   * Fetch repository by owner and name.
   *
   * @param {string} owner
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async getRepositoryByOwnerAndName(owner, name) {
    const { data, error } = await this.supabase
      .from("repositories")
      .select("id, owner, name, full_name, html_url, default_branch, created_at")
      .eq("owner", owner)
      .eq("name", name)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to query repository by owner/name: ${error.message}`);
    }
    return data;
  }

  /**
   * Fetch repository indexing state.
   *
   * @param {string} repositoryId
   * @returns {Promise<object|null>}
   */
  async getRepositoryIndexState(repositoryId) {
    const { data, error } = await this.supabase
      .from("repository_index_state")
      .select("repository_id, indexed_commit_sha, latest_seen_commit_sha, status, last_success_at, last_error")
      .eq("repository_id", repositoryId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to query repository_index_state: ${error.message}`);
    }
    return data;
  }

  /**
   * Get exact count of indexed code chunks for a repository.
   *
   * @param {string} repositoryId
   * @returns {Promise<number>}
   */
  async getChunkCount(repositoryId) {
    const { count, error } = await this.supabase
      .from("code_chunks")
      .select("*", { count: "exact", head: true })
      .eq("repository_id", repositoryId);

    if (error) {
      throw new Error(`Failed to count code_chunks: ${error.message}`);
    }
    return count || 0;
  }

  /**
   * Execute vector similarity search via Supabase match_code_chunks RPC.
   *
   * The deployed function signature (source of truth) is:
   *   match_code_chunks(
   *     p_repository_id   uuid,
   *     p_embedding_model text,
   *     p_query_embedding vector,
   *     p_match_count     integer DEFAULT 10
   *   )
   * and it returns: chunk_id, file_path, start_line, end_line, commit_sha, content, similarity.
   *
   * Callers that pass `embeddingModel` (and a `repositoryId`) use that deployed signature
   * first. Older/simpler signatures are attempted as a fallback so the repository keeps
   * working against alternate database deployments.
   *
   * Because the deployed function has no threshold argument, `matchThreshold` is applied
   * client-side to the returned matches so the documented API behaviour is honoured.
   *
   * @param {object} params
   * @param {number[]} params.queryEmbedding 768-dimensional normalized embedding
   * @param {number} [params.matchThreshold=0.0] Minimum similarity (0–1) to keep a match
   * @param {number} [params.matchCount=5]
   * @param {string} [params.repositoryId]
   * @param {string} [params.embeddingModel] Model name stored alongside indexed chunks
   * @returns {Promise<Array<object>>}
   */
  async matchCodeChunks({
    queryEmbedding,
    matchThreshold = 0.0,
    matchCount = 5,
    repositoryId = null,
    embeddingModel = null,
  } = {}) {
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      throw new Error("queryEmbedding must be a non-empty array");
    }

    // Candidate parameter sets, most-preferred first.
    const candidates = [];

    // 1. Deployed signature (requires the embedding model name used at index time).
    if (repositoryId && embeddingModel) {
      candidates.push({
        p_repository_id: repositoryId,
        p_embedding_model: embeddingModel,
        p_query_embedding: queryEmbedding,
        p_match_count: matchCount,
      });
    }

    // 2. Legacy signatures (no embedding-model filter).
    const legacy = {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
    };
    if (repositoryId) {
      candidates.push({ ...legacy, filter_repository_id: repositoryId });
      candidates.push({ ...legacy, repository_id: repositoryId });
    }
    candidates.push(legacy);

    let data = null;
    let lastError = null;

    for (const params of candidates) {
      const res = await this.supabase.rpc("match_code_chunks", params);
      if (!res.error) {
        data = res.data;
        lastError = null;
        break;
      }
      lastError = res.error;
      // Only keep trying alternate signatures when the function/arguments did not match.
      if (!isSignatureMismatch(res.error)) {
        break;
      }
    }

    if (lastError) {
      throw new Error(`Vector search failed via match_code_chunks RPC: ${lastError.message}`);
    }

    const rows = (data || []).filter((chunk) => {
      // Defensive check: ensure no unrelated repository chunks slip through
      if (repositoryId && chunk.repository_id && chunk.repository_id !== repositoryId) {
        return false;
      }
      return true;
    });

    // Normalize the deployed RPC output: it returns `chunk_id`, while callers expect `id`.
    const normalized = rows.map((chunk) => {
      const similarity =
        typeof chunk.similarity === "number" ? chunk.similarity : Number(chunk.similarity);
      return {
        ...chunk,
        id: chunk.id ?? chunk.chunk_id,
        similarity,
      };
    });

    // Apply the similarity threshold client-side (deployed RPC has no threshold argument).
    if (typeof matchThreshold === "number" && matchThreshold > 0) {
      return normalized.filter(
        (chunk) => typeof chunk.similarity !== "number" || Number.isNaN(chunk.similarity) || chunk.similarity >= matchThreshold
      );
    }

    return normalized;
  }
}

/**
 * Detect a PostgREST signature/argument mismatch, which means we should try
 * another parameter shape rather than surfacing the error.
 *
 * @param {object} error
 * @returns {boolean}
 */
function isSignatureMismatch(error) {
  if (!error) return false;
  if (error.code === "PGRST202") return true;
  const message = error.message || "";
  return /could not find the function|does not exist|schema cache/i.test(message);
}
