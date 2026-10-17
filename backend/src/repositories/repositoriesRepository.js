/**
 * repositoriesRepository.js
 *
 * Encapsulates all Supabase database interactions for:
 * - repositories table (lookup or create)
 * - repository_index_state table (state transitions: running -> idle/failed)
 * - code_chunks table (clear obsolete chunks, batch persist new chunks with vectors)
 */

export class RepositoriesRepository {
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
   * Find an existing repository by owner & name, or insert a new record.
   *
   * @param {object} params
   * @param {string} params.owner
   * @param {string} params.name
   * @param {string} params.htmlUrl
   * @param {string} [params.defaultBranch]
   * @returns {Promise<object>} Repository row
   */
  async findOrCreateRepository({ owner, name, htmlUrl, defaultBranch }) {
    // 1. Check if repository already exists
    const { data: existing, error: selectErr } = await this.supabase
      .from("repositories")
      .select("*")
      .eq("owner", owner)
      .eq("name", name)
      .maybeSingle();

    if (selectErr) {
      throw new Error(`Failed to query repository: ${selectErr.message}`);
    }

    if (existing) {
      // Update default_branch or html_url if changed
      if (
        (defaultBranch && existing.default_branch !== defaultBranch) ||
        (htmlUrl && existing.html_url !== htmlUrl)
      ) {
        const { data: updated, error: updateErr } = await this.supabase
          .from("repositories")
          .update({
            html_url: htmlUrl || existing.html_url,
            default_branch: defaultBranch || existing.default_branch,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id)
          .select("*")
          .single();

        if (!updateErr && updated) return updated;
      }
      return existing;
    }

    // 2. Insert new repository
    const { data: inserted, error: insertErr } = await this.supabase
      .from("repositories")
      .insert({
        owner,
        name,
        html_url: htmlUrl,
        default_branch: defaultBranch,
      })
      .select("*")
      .single();

    if (insertErr) {
      throw new Error(`Failed to insert repository: ${insertErr.message}`);
    }

    return inserted;
  }

  /**
   * Get or create repository_index_state row.
   *
   * @param {string} repositoryId
   * @returns {Promise<object>}
   */
  async getOrCreateState(repositoryId) {
    const { data: state, error: selectErr } = await this.supabase
      .from("repository_index_state")
      .select("*")
      .eq("repository_id", repositoryId)
      .maybeSingle();

    if (selectErr) {
      throw new Error(`Failed to get repository_index_state: ${selectErr.message}`);
    }

    if (state) return state;

    const { data: created, error: insertErr } = await this.supabase
      .from("repository_index_state")
      .insert({
        repository_id: repositoryId,
        status: "idle",
      })
      .select("*")
      .single();

    if (insertErr) {
      throw new Error(`Failed to initialize repository_index_state: ${insertErr.message}`);
    }

    return created;
  }

  /**
   * Mark index state as 'running' with latest seen SHA.
   *
   * @param {string} repositoryId
   * @param {string} latestSeenCommitSha
   */
  async setIndexStateRunning(repositoryId, latestSeenCommitSha) {
    const { data, error } = await this.supabase
      .from("repository_index_state")
      .upsert(
        {
          repository_id: repositoryId,
          latest_seen_commit_sha: latestSeenCommitSha,
          status: "running",
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "repository_id" }
      )
      .select("*")
      .single();

    if (error) {
      throw new Error(`Failed to update state to running: ${error.message}`);
    }

    return data;
  }

  /**
   * Mark index state as 'failed' with error message.
   *
   * @param {string} repositoryId
   * @param {string} errorMessage
   */
  async setIndexStateFailed(repositoryId, errorMessage) {
    const { data, error } = await this.supabase
      .from("repository_index_state")
      .upsert(
        {
          repository_id: repositoryId,
          status: "failed",
          last_error: errorMessage,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "repository_id" }
      )
      .select("*")
      .single();

    if (error) {
      console.error(`Failed to record failed index state: ${error.message}`);
    }

    return data;
  }

  /**
   * Atomically replace chunks for this repository and update indexed_commit_sha.
   *
   * @param {object} params
   * @param {string} params.repositoryId
   * @param {string} params.commitSha
   * @param {Array<object>} params.embeddedChunks
   */
  async saveChunksAndCompleteIndex({ repositoryId, commitSha, embeddedChunks }) {
    // 1. Remove obsolete chunks for this repository
    const { error: deleteErr } = await this.supabase
      .from("code_chunks")
      .delete()
      .eq("repository_id", repositoryId);

    if (deleteErr) {
      throw new Error(`Failed to clean obsolete code_chunks: ${deleteErr.message}`);
    }

    // 2. Insert new chunks in batches
    if (embeddedChunks.length > 0) {
      const rows = embeddedChunks.map((chunk) => ({
        repository_id: repositoryId,
        file_path: chunk.file_path,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        commit_sha: chunk.commit_sha,
        blob_sha: chunk.blob_sha,
        embedding_model: chunk.embedding_model,
        embedding_dimensions: chunk.embedding_dimensions,
        embedding: chunk.embedding,
      }));

      const BATCH_SIZE = 100;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const { error: insertErr } = await this.supabase
          .from("code_chunks")
          .insert(batch);

        if (insertErr) {
          throw new Error(`Failed to insert code_chunks batch: ${insertErr.message}`);
        }
      }
    }

    // 3. Mark index state as idle and advance indexed_commit_sha
    const { data: updatedState, error: stateErr } = await this.supabase
      .from("repository_index_state")
      .upsert(
        {
          repository_id: repositoryId,
          indexed_commit_sha: commitSha,
          latest_seen_commit_sha: commitSha,
          status: "idle",
          last_success_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "repository_id" }
      )
      .select("*")
      .single();

    if (stateErr) {
      throw new Error(`Failed to finalize repository_index_state: ${stateErr.message}`);
    }

    return updatedState;
  }

  /**
   * Get total number of stored chunks for a repository.
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
      throw new Error(`Failed to get chunk count: ${error.message}`);
    }

    return count || 0;
  }

  /**
   * Find a repository by UUID.
   *
   * @param {string} repositoryId
   * @returns {Promise<object|null>}
   */
  async getRepositoryById(repositoryId) {
    const { data, error } = await this.supabase
      .from("repositories")
      .select("*")
      .eq("id", repositoryId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to query repository by id: ${error.message}`);
    }

    return data;
  }

  /**
   * List all tracked repositories with their latest index state.
   *
   * @returns {Promise<Array<object>>}
   */
  async listTrackedRepositories() {
    const { data: repos, error: reposErr } = await this.supabase
      .from("repositories")
      .select("*")
      .order("created_at", { ascending: true });

    if (reposErr) {
      throw new Error(`Failed to list repositories: ${reposErr.message}`);
    }

    if (!repos || repos.length === 0) {
      return [];
    }

    const repoIds = repos.map((r) => r.id);
    const { data: states, error: statesErr } = await this.supabase
      .from("repository_index_state")
      .select("*")
      .in("repository_id", repoIds);

    if (statesErr) {
      throw new Error(`Failed to load repository_index_state: ${statesErr.message}`);
    }

    const stateMap = new Map((states || []).map((s) => [s.repository_id, s]));

    return repos.map((r) => ({
      ...r,
      indexState: stateMap.get(r.id) || null,
    }));
  }

  /**
   * Delete code chunks for specific file paths in a repository.
   *
   * @param {object} params
   * @param {string} params.repositoryId
   * @param {string[]} params.filePaths
   * @returns {Promise<number>} Number of deleted chunks
   */
  async deleteChunksForFiles({ repositoryId, filePaths }) {
    if (!repositoryId) throw new Error("repositoryId is required");
    if (!Array.isArray(filePaths) || filePaths.length === 0) return 0;

    const BATCH_SIZE = 100;
    let totalDeleted = 0;

    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      const batch = filePaths.slice(i, i + BATCH_SIZE);
      const { data, error, count } = await this.supabase
        .from("code_chunks")
        .delete({ count: "exact" })
        .eq("repository_id", repositoryId)
        .in("file_path", batch);

      if (error) {
        throw new Error(`Failed to delete chunks for files: ${error.message}`);
      }

      totalDeleted += (count ?? (Array.isArray(data) ? data.length : 0));
    }

    return totalDeleted;
  }

  /**
   * Insert new embedded code chunks in batches.
   *
   * @param {object} params
   * @param {string} params.repositoryId
   * @param {Array<object>} params.embeddedChunks
   * @returns {Promise<number>}
   */
  async insertChunks({ repositoryId, embeddedChunks }) {
    if (!repositoryId) throw new Error("repositoryId is required");
    if (!Array.isArray(embeddedChunks) || embeddedChunks.length === 0) return 0;

    const rows = embeddedChunks.map((chunk) => ({
      repository_id: repositoryId,
      file_path: chunk.file_path,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      commit_sha: chunk.commit_sha,
      blob_sha: chunk.blob_sha,
      embedding_model: chunk.embedding_model,
      embedding_dimensions: chunk.embedding_dimensions,
      embedding: chunk.embedding,
    }));

    const BATCH_SIZE = 100;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await this.supabase
        .from("code_chunks")
        .insert(batch);

      if (error) {
        throw new Error(`Failed to insert code_chunks batch: ${error.message}`);
      }
    }

    return rows.length;
  }

  /**
   * Update index state to 'idle' with newly indexed commit SHA.
   *
   * @param {object} params
   * @param {string} params.repositoryId
   * @param {string} params.commitSha
   * @returns {Promise<object>}
   */
  async updateIndexStateSuccess({ repositoryId, commitSha }) {
    const { data, error } = await this.supabase
      .from("repository_index_state")
      .upsert(
        {
          repository_id: repositoryId,
          indexed_commit_sha: commitSha,
          latest_seen_commit_sha: commitSha,
          status: "idle",
          last_success_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "repository_id" }
      )
      .select("*")
      .single();

    if (error) {
      throw new Error(`Failed to update index state to success: ${error.message}`);
    }

    return data;
  }
}

