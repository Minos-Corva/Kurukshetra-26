/**
 * pollingService.js
 *
 * Implements Feature 9: GitHub commit polling and incremental repository updates.
 *
 * 1. Checks configured GitHub repositories for new commits on their target branches.
 * 2. Compares new commit SHA with the last successfully indexed SHA.
 * 3. Skips repositories whose commit has not changed.
 * 4. For changed repositories:
 *    - Fetches commit comparison from GitHub (added, modified, deleted, renamed files).
 *    - Cleans up stale chunks for deleted, renamed, or modified files.
 *    - Chunks, embeds, and indexes only added, modified, and renamed files.
 *    - Ignores unsupported, excluded, or oversized files according to ingestion rules.
 *    - Unchanged files are not touched or reprocessed.
 * 5. Advances indexed_commit_sha only after all updates and deletions succeed.
 * 6. Leaves prior SHA intact on failure so the next poll retries.
 * 7. Safe against concurrent or overlapping runs for the same repository.
 */

import { isEligibleFile } from "./githubIngestionService.js";

const DEFAULT_POLLING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export class PollingService {
  /**
   * @param {object} options
   * @param {import('./githubIngestionService.js').GithubIngestionService} options.githubService
   * @param {import('./chunkingService.js').ChunkingService} options.chunkingService
   * @param {import('./embeddingService.js').EmbeddingService} options.embeddingService
   * @param {import('../repositories/repositoriesRepository.js').RepositoriesRepository} options.repository
   * @param {number} [options.pollingIntervalMs]
   * @param {object} [options.logger]
   */
  constructor({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    assessmentRepository,
    assessmentService,
    pollingIntervalMs = DEFAULT_POLLING_INTERVAL_MS,
    logger = console,
  } = {}) {
    if (!githubService) throw new Error("githubService is required");
    if (!chunkingService) throw new Error("chunkingService is required");
    if (!embeddingService) throw new Error("embeddingService is required");
    if (!repository) throw new Error("repository is required");

    this.githubService = githubService;
    this.chunkingService = chunkingService;
    this.embeddingService = embeddingService;
    this.repository = repository;
    this.assessmentRepository = assessmentRepository;
    this.assessmentService = assessmentService;
    this.pollingIntervalMs = pollingIntervalMs;
    this.logger = logger;

    this.activeRepoRuns = new Set();
    this.isPollingAll = false;
    this.timer = null;
  }

  async reassessRepository(repositoryId) {
    if (!this.assessmentRepository || !this.assessmentService) return [];
    let targets;
    try {
      targets = await this.assessmentRepository.listAssessmentTargetsByRepository(repositoryId);
    } catch (error) {
      const message = (error.message || "Could not find saved assessments").slice(0, 255);
      this.logger.error(`[Polling] Could not load reassessment targets: ${message}`);
      return [{ status: "failed", error: message }];
    }
    const results = [];
    for (const target of targets) {
      try {
        const result = await this.assessmentService.assess({
          jobPostingId: target.job_posting_id,
          repositoryId: target.repository_id,
        });
        results.push({ jobPostingId: target.job_posting_id, assessmentId: result.assessment.id, status: "updated" });
        this.logger.log(`[Polling] Reassessed posting ${target.job_posting_id} at ${result.assessment.commitSha?.slice(0, 7)} (assessment ${result.assessment.id})`);
      } catch (error) {
        results.push({ jobPostingId: target.job_posting_id, status: "failed", error: (error.message || "Assessment failed").slice(0, 255) });
        this.logger.error(`[Polling] Reassessment failed for posting ${target.job_posting_id}: ${(error.message || "Assessment failed").slice(0, 255)}`);
      }
    }
    return results;
  }

  /**
   * Poll a single repository and apply incremental updates if the branch has advanced.
   *
   * @param {object} params
   * @param {string} [params.repositoryId]
   * @param {string} [params.owner]
   * @param {string} [params.name]
   * @param {string} [params.branch]
   * @returns {Promise<object>} Outcome summary
   */
  async pollRepository({ repositoryId, owner, name, branch } = {}) {
    // 1. Resolve repository entity
    let repo = null;
    if (repositoryId) {
      repo = await this.repository.getRepositoryById(repositoryId);
      if (!repo) {
        throw new Error(`Repository with ID '${repositoryId}' not found.`);
      }
    } else if (owner && name) {
      repo = await this.repository.findOrCreateRepository({
        owner,
        name,
        htmlUrl: `https://github.com/${owner}/${name}`,
      });
    } else {
      throw new Error("repositoryId or owner and name are required");
    }

    const repoId = repo.id;
    const repoFullName = repo.full_name || `${repo.owner}/${repo.name}`;

    // 2. Prevent overlapping runs for the same repository in-process
    if (this.activeRepoRuns.has(repoId)) {
      this.logger.warn(`[Polling] Run already active in this process for ${repoFullName}, skipping.`);
      return {
        repositoryId: repoId,
        repositoryName: repoFullName,
        status: "skipped",
        reason: "in_progress_locally",
      };
    }

    this.activeRepoRuns.add(repoId);

    try {
      // 3. Load or initialize repository_index_state
      const state = await this.repository.getOrCreateState(repoId);

      // Guard against stale or concurrent running state from other workers
      if (state.status === "running" && state.updated_at) {
        const elapsedMs = Date.now() - new Date(state.updated_at).getTime();
        if (elapsedMs < STALE_RUNNING_THRESHOLD_MS) {
          this.logger.warn(
            `[Polling] Repository ${repoFullName} is currently marked 'running' in DB (${Math.round(elapsedMs / 1000)}s ago), skipping.`
          );
          return {
            repositoryId: repoId,
            repositoryName: repoFullName,
            status: "skipped",
            reason: "in_progress_remotely",
          };
        }
        this.logger.warn(
          `[Polling] Repository ${repoFullName} was marked 'running' over ${Math.round(elapsedMs / 1000)}s ago; assuming stale and proceeding.`
        );
      }

      const targetBranch = branch || repo.default_branch || "main";

      // 4. Fetch the latest commit SHA from GitHub for the target branch
      this.logger.log(`[Polling] Checking ${repoFullName} (branch: ${targetBranch})`);
      const { sha: latestCommitSha } = await this.githubService.getCommitSha({
        owner: repo.owner,
        name: repo.name,
        ref: targetBranch,
      });

      // 5. Compare with last indexed commit SHA
      if (state.indexed_commit_sha && state.indexed_commit_sha === latestCommitSha) {
        this.logger.log(
          `[Polling] ${repoFullName}: up to date at commit ${latestCommitSha.slice(0, 7)}`
        );
        const result = {
          repositoryId: repoId,
          repositoryName: repoFullName,
          status: "unchanged",
          commitSha: latestCommitSha,
        };
        return result;
      }

      // 6. Handle case where repository was never indexed before (no prior commit SHA)
      if (!state.indexed_commit_sha) {
        this.logger.log(
          `[Polling] ${repoFullName}: no previous indexed commit; performing initial full ingestion at ${latestCommitSha.slice(0, 7)}`
        );
        await this.repository.setIndexStateRunning(repoId, latestCommitSha);

        const ingestResult = await this.githubService.ingestRepository({
          owner: repo.owner,
          name: repo.name,
          branch: targetBranch,
        });

        const rawChunks = this.chunkingService.chunkFiles(ingestResult.files);
        const embeddedChunks = await this.embeddingService.embedChunks(rawChunks);

        await this.repository.saveChunksAndCompleteIndex({
          repositoryId: repoId,
          commitSha: ingestResult.commitSha,
          embeddedChunks,
        });

        this.logger.log(
          `[Polling] ${repoFullName}: initial ingestion complete at ${ingestResult.commitSha.slice(0, 7)} (${ingestResult.files.length} files, ${embeddedChunks.length} chunks)`
        );

        return {
          repositoryId: repoId,
          repositoryName: repoFullName,
          status: "initial_indexed",
          oldCommitSha: null,
          newCommitSha: ingestResult.commitSha,
          fileCount: ingestResult.files.length,
          chunkCount: embeddedChunks.length,
        };
        result.assessments = await this.reassessRepository(repoId);
        return result;
      }

      // 7. Branch has advanced: perform incremental update
      const oldCommitSha = state.indexed_commit_sha;
      this.logger.log(
        `[Polling] ${repoFullName}: commit changed from ${oldCommitSha.slice(0, 7)} to ${latestCommitSha.slice(0, 7)}`
      );

      await this.repository.setIndexStateRunning(repoId, latestCommitSha);

      // Fetch changed files via GitHub compare API
      let comparison;
      try {
        comparison = await this.githubService.compareCommits({
          owner: repo.owner,
          name: repo.name,
          baseSha: oldCommitSha,
          headSha: latestCommitSha,
        });
      } catch (compErr) {
        // If comparison failed because the base commit does not exist (e.g. force push / rebase)
        const errMsg = compErr.message || "";
        if (errMsg.includes("not found") || errMsg.includes("404") || errMsg.includes("422")) {
          this.logger.warn(
            `[Polling] Commit comparison ${oldCommitSha.slice(0, 7)}...${latestCommitSha.slice(0, 7)} failed (${errMsg}); falling back to full re-index.`
          );
          const fullIngest = await this.githubService.ingestRepository({
            owner: repo.owner,
            name: repo.name,
            branch: targetBranch,
          });
          const rawChunks = this.chunkingService.chunkFiles(fullIngest.files);
          const embeddedChunks = await this.embeddingService.embedChunks(rawChunks);
          await this.repository.saveChunksAndCompleteIndex({
            repositoryId: repoId,
            commitSha: fullIngest.commitSha,
            embeddedChunks,
          });
          const result = {
            repositoryId: repoId,
            repositoryName: repoFullName,
            status: "reindexed_full",
            oldCommitSha,
            newCommitSha: fullIngest.commitSha,
            fileCount: fullIngest.files.length,
            chunkCount: embeddedChunks.length,
          };
          result.assessments = await this.reassessRepository(repoId);
          return result;
        }
        throw compErr;
      }

      const files = comparison.files || [];

      // If comparison shows zero changed files (e.g. empty commit / branch merge without changes)
      if (files.length === 0) {
        await this.repository.updateIndexStateSuccess({
          repositoryId: repoId,
          commitSha: latestCommitSha,
        });
        this.logger.log(
          `[Polling] ${repoFullName}: no file differences in commit range; advanced index to ${latestCommitSha.slice(0, 7)}`
        );
        const result = {
          repositoryId: repoId,
          repositoryName: repoFullName,
          status: "updated",
          oldCommitSha,
          newCommitSha: latestCommitSha,
          stats: {
            added: 0,
            modified: 0,
            deleted: 0,
            renamed: 0,
            skipped: 0,
            oversized: 0,
            chunksDeleted: 0,
            chunksInserted: 0,
          },
        };
        result.assessments = await this.reassessRepository(repoId);
        return result;
      }

      // Categorize changed files
      const filePathsToDelete = new Set();
      const filesToFetchAndChunk = [];
      const stats = {
        added: 0,
        modified: 0,
        deleted: 0,
        renamed: 0,
        skipped: 0,
        oversized: 0,
      };
      const skippedFiles = [];

      for (const file of files) {
        const filePath = (file.filename || "").replace(/\\/g, "/");
        const status = file.status; // 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed'

        if (status === "removed") {
          filePathsToDelete.add(filePath);
          stats.deleted++;
          continue;
        }

        if (status === "renamed") {
          if (file.previous_filename) {
            filePathsToDelete.add(file.previous_filename.replace(/\\/g, "/"));
          }
          filePathsToDelete.add(filePath);
          stats.renamed++;

          if (!isEligibleFile(filePath)) {
            stats.skipped++;
            skippedFiles.push({ filePath, reason: "ineligible_extension_or_path" });
            continue;
          }

          filesToFetchAndChunk.push({ filePath, blobSha: file.sha });
          continue;
        }

        if (status === "modified" || status === "changed") {
          filePathsToDelete.add(filePath);
          stats.modified++;

          if (!isEligibleFile(filePath)) {
            stats.skipped++;
            skippedFiles.push({ filePath, reason: "ineligible_extension_or_path" });
            continue;
          }

          filesToFetchAndChunk.push({ filePath, blobSha: file.sha });
          continue;
        }

        if (status === "added" || status === "copied") {
          // Add to deletion list too as a defense against retrying partially applied runs
          filePathsToDelete.add(filePath);
          stats.added++;

          if (!isEligibleFile(filePath)) {
            stats.skipped++;
            skippedFiles.push({ filePath, reason: "ineligible_extension_or_path" });
            continue;
          }

          filesToFetchAndChunk.push({ filePath, blobSha: file.sha });
          continue;
        }
      }

      // Fetch blob contents and validate file sizes
      const readyFiles = [];
      for (const item of filesToFetchAndChunk) {
        const blob = await this.githubService.fetchBlobContent({
          owner: repo.owner,
          name: repo.name,
          fileSha: item.blobSha,
        });

        if (blob.size > this.githubService.maxFileSize) {
          stats.oversized++;
          skippedFiles.push({ filePath: item.filePath, reason: "file_size_exceeded_100kb" });
          // Ensure old chunks for this path are cleared if it was previously indexed and grew oversized
          filePathsToDelete.add(item.filePath);
          continue;
        }

        readyFiles.push({
          filePath: item.filePath,
          content: blob.content,
          blobSha: item.blobSha,
          commitSha: latestCommitSha,
        });
      }

      // Chunk and embed only the eligible new/modified files
      const rawChunks = this.chunkingService.chunkFiles(readyFiles);
      const embeddedChunks = rawChunks.length > 0 ? await this.embeddingService.embedChunks(rawChunks) : [];

      // Persist changes:
      // 1. Remove stale chunks for affected files
      const deletedChunksCount = await this.repository.deleteChunksForFiles({
        repositoryId: repoId,
        filePaths: Array.from(filePathsToDelete),
      });

      // 2. Insert new chunks
      if (embeddedChunks.length > 0) {
        await this.repository.insertChunks({
          repositoryId: repoId,
          embeddedChunks,
        });
      }

      // 3. Mark success and advance indexed_commit_sha ONLY after all deletions and inserts succeeded
      await this.repository.updateIndexStateSuccess({
        repositoryId: repoId,
        commitSha: latestCommitSha,
      });

      this.logger.log(
        `[Polling] ${repoFullName}: successfully updated ${oldCommitSha.slice(0, 7)} -> ${latestCommitSha.slice(0, 7)} (+${stats.added}, ~${stats.modified}, -${stats.deleted}, ->${stats.renamed}, ${stats.skipped} skipped, ${stats.oversized} oversized; ${embeddedChunks.length} chunks added, ${deletedChunksCount} chunks deleted)`
      );

      const result = {
        repositoryId: repoId,
        repositoryName: repoFullName,
        status: "updated",
        oldCommitSha,
        newCommitSha: latestCommitSha,
        stats: {
          ...stats,
          chunksDeleted: deletedChunksCount,
          chunksInserted: embeddedChunks.length,
        },
        skippedFiles,
      };
      result.assessments = await this.reassessRepository(repoId);
      return result;
    } catch (err) {
      const rawMessage = err.message || "Unknown polling failure";
      const safeReason = rawMessage.slice(0, 255);

      this.logger.error(`[Polling] Failed to update repository ${repoFullName}: ${safeReason}`);

      // Record failed state in DB without advancing indexed_commit_sha
      try {
        await this.repository.setIndexStateFailed(repoId, safeReason);
      } catch (dbErr) {
        this.logger.error(`[Polling] Failed to record failed state in database: ${dbErr.message}`);
      }

      return {
        repositoryId: repoId,
        repositoryName: repoFullName,
        status: "failed",
        error: safeReason,
      };
    } finally {
      this.activeRepoRuns.delete(repoId);
    }
  }

  /**
   * Run one full polling cycle across all tracked repositories.
   *
   * @returns {Promise<{ status: string, count: number, results: Array<object> }>}
   */
  async pollAll() {
    if (this.isPollingAll) {
      this.logger.warn("[Polling] A full polling cycle is already in progress, skipping this run.");
      return { status: "skipped", reason: "cycle_in_progress", results: [] };
    }

    this.isPollingAll = true;
    try {
      const trackedRepos = await this.repository.listTrackedRepositories();
      this.logger.log(`[Polling] Starting polling cycle for ${trackedRepos.length} repository/repositories.`);

      const results = [];
      for (const repo of trackedRepos) {
        try {
          const res = await this.pollRepository({ repositoryId: repo.id });
          results.push(res);
        } catch (err) {
          results.push({
            repositoryId: repo.id,
            repositoryName: repo.full_name || `${repo.owner}/${repo.name}`,
            status: "failed",
            error: err.message,
          });
        }
      }

      this.logger.log(`[Polling] Completed polling cycle for ${trackedRepos.length} repository/repositories.`);
      return {
        status: "completed",
        count: trackedRepos.length,
        results,
      };
    } finally {
      this.isPollingAll = false;
    }
  }

  /**
   * Start periodic background polling.
   */
  start() {
    if (this.timer) {
      this.logger.log("[Polling] Background timer is already running.");
      return;
    }

    this.logger.log(`[Polling] Starting background polling timer (${this.pollingIntervalMs}ms interval).`);

    this.timer = setInterval(() => {
      this.pollAll().catch((err) => {
        this.logger.error(`[Polling] Background polling cycle threw an unhandled error: ${err.message}`);
      });
    }, this.pollingIntervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stop periodic background polling.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.log("[Polling] Background polling timer stopped.");
    }
  }
}
