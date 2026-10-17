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
   * Tries compatible parameter signatures:
   * 1. { query_embedding, match_threshold, match_count, filter_repository_id }
   * 2. { query_embedding, match_threshold, match_count, repository_id }
   * 3. { query_embedding, match_threshold, match_count } + client-side scoping
   *
   * @param {object} params
   * @param {number[]} params.queryEmbedding 768-dimensional normalized embedding
   * @param {number} [params.matchThreshold=0.0]
   * @param {number} [params.matchCount=5]
   * @param {string} [params.repositoryId]
   * @returns {Promise<Array<object>>}
   */
  async matchCodeChunks({ queryEmbedding, matchThreshold = 0.0, matchCount = 5, repositoryId = null }) {
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      throw new Error("queryEmbedding must be a non-empty array");
    }

    // Try signature 1: filter_repository_id
    const params1 = {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
    };
    if (repositoryId) {
      params1.filter_repository_id = repositoryId;
    }

    let { data, error } = await this.supabase.rpc("match_code_chunks", params1);

    // If signature 1 failed because parameter was not found or function mismatch, try signature 2: repository_id
    if (error && (error.message?.includes("filter_repository_id") || error.code === "PGRST202")) {
      const params2 = {
        query_embedding: queryEmbedding,
        match_threshold: matchThreshold,
        match_count: matchCount,
      };
      if (repositoryId) {
        params2.repository_id = repositoryId;
      }
      const res2 = await this.supabase.rpc("match_code_chunks", params2);
      if (!res2.error) {
        data = res2.data;
        error = null;
      } else if (res2.error && (res2.error.message?.includes("repository_id") || res2.error.code === "PGRST202")) {
        // Try signature 3: 3-param match_code_chunks without repository param, filter in client
        const res3 = await this.supabase.rpc("match_code_chunks", {
          query_embedding: queryEmbedding,
          match_threshold: matchThreshold,
          match_count: repositoryId ? matchCount * 3 : matchCount,
        });
        if (!res3.error) {
          data = (res3.data || [])
            .filter((chunk) => !repositoryId || chunk.repository_id === repositoryId)
            .slice(0, matchCount);
          error = null;
        } else {
          error = res3.error;
        }
      } else {
        error = res2.error;
      }
    }

    if (error) {
      throw new Error(`Vector search failed via match_code_chunks RPC: ${error.message}`);
    }

    return (data || []).filter((chunk) => {
      // Defensive check: ensure no unrelated repository chunks slip through
      if (repositoryId && chunk.repository_id && chunk.repository_id !== repositoryId) {
        return false;
      }
      return true;
    });
  }
}
