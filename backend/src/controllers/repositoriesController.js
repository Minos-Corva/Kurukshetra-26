/**
 * repositoriesController.js
 *
 * Orchestrates GitHub ingestion, line chunking, embedding generation, and Supabase persistence.
 * Validates inputs with Zod and returns safe, sanitized responses without exposing secrets or file contents.
 */

import { z } from "zod";

const IngestRequestSchema = z.object({
  owner: z
    .string({ required_error: "owner is required" })
    .min(1, "owner is required")
    .regex(/^[a-zA-Z0-9_.-]+$/, "owner contains invalid characters"),
  name: z
    .string({ required_error: "name is required" })
    .min(1, "name is required")
    .regex(/^[a-zA-Z0-9_.-]+$/, "name contains invalid characters"),
  branch: z.string().optional(),
});

export class RepositoriesController {
  /**
   * @param {object} options
   * @param {import('../services/githubIngestionService.js').GithubIngestionService} options.githubService
   * @param {import('../services/chunkingService.js').ChunkingService} options.chunkingService
   * @param {import('../services/embeddingService.js').EmbeddingService} options.embeddingService
   * @param {import('../repositories/repositoriesRepository.js').RepositoriesRepository} options.repository
   */
  constructor({ githubService, chunkingService, embeddingService, repository } = {}) {
    if (!githubService) throw new Error("githubService is required");
    if (!chunkingService) throw new Error("chunkingService is required");
    if (!embeddingService) throw new Error("embeddingService is required");
    if (!repository) throw new Error("repository is required");

    this.githubService = githubService;
    this.chunkingService = chunkingService;
    this.embeddingService = embeddingService;
    this.repository = repository;
  }

  /**
   * POST /api/repositories/ingest
   */
  async ingest(req, res) {
    const parseResult = IngestRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Invalid input",
        details: parseResult.error.issues.map((i) => i.message),
      });
    }

    const { owner, name, branch } = parseResult.data;
    let repoRow = null;

    try {
      // 1. Fetch metadata and files from GitHub
      const { repository: gitRepo, commitSha, files } = await this.githubService.ingestRepository({
        owner,
        name,
        branch,
      });

      // 2. Find or create repository row in database
      repoRow = await this.repository.findOrCreateRepository({
        owner: gitRepo.owner,
        name: gitRepo.name,
        htmlUrl: gitRepo.htmlUrl,
        defaultBranch: gitRepo.defaultBranch,
      });

      // 3. Check current index state
      const currentState = await this.repository.getOrCreateState(repoRow.id);

      // Check if already indexed at this commit SHA
      if (currentState.indexed_commit_sha === commitSha) {
        const chunkCount = await this.repository.getChunkCount(repoRow.id);
        return res.status(200).json({
          repository: repoRow,
          indexedCommitSha: commitSha,
          fileCount: files.length,
          chunkCount,
          status: "idle",
          message: "Repository is already indexed at this commit SHA",
        });
      }

      // 4. Mark state as running
      await this.repository.setIndexStateRunning(repoRow.id, commitSha);

      // 5. Chunk eligible files
      const rawChunks = this.chunkingService.chunkFiles(files);

      // 6. Generate embeddings
      const embeddedChunks = await this.embeddingService.embedChunks(rawChunks);

      // 7. Persist chunks and advance indexed_commit_sha
      await this.repository.saveChunksAndCompleteIndex({
        repositoryId: repoRow.id,
        commitSha,
        embeddedChunks,
      });

      return res.status(201).json({
        repository: repoRow,
        indexedCommitSha: commitSha,
        fileCount: files.length,
        chunkCount: embeddedChunks.length,
        status: "idle",
      });
    } catch (err) {
      const rawMessage = err.message || "Unknown error";

      // If repo record exists, mark index state as failed
      if (repoRow && repoRow.id) {
        const safeReason = rawMessage.slice(0, 255);
        await this.repository.setIndexStateFailed(repoRow.id, safeReason);
      }

      // Safe error responses
      if (rawMessage.includes("not found")) {
        return res.status(404).json({
          error: "Repository not found",
          message: "The requested repository or branch was not found or is inaccessible.",
        });
      }

      if (rawMessage.includes("rate limit") || rawMessage.includes("forbidden")) {
        return res.status(429).json({
          error: "GitHub rate limit exceeded",
          message: "GitHub API rate limit exceeded. Please try again later or configure a GITHUB_TOKEN.",
        });
      }

      if (rawMessage.includes("dimension mismatch")) {
        return res.status(500).json({
          error: "Embedding error",
          message: "Failed to generate embeddings with the expected dimensions.",
        });
      }

      if (rawMessage.includes("supabase") || rawMessage.includes("database")) {
        return res.status(500).json({
          error: "Database error",
          message: "Unable to persist repository index data.",
        });
      }

      return res.status(500).json({
        error: "Ingestion failed",
        message: "An unexpected error occurred during repository ingestion.",
      });
    }
  }
}
