/**
 * evidenceService.js
 *
 * Implements Feature 6: Evidence Retrieval.
 * Given a job posting or assessment ID and repository scope:
 * 1. Resolves and validates job posting, assessment, and repository.
 * 2. Verifies repository is fully indexed with stored chunks.
 * 3. Loads requirements and generates query embeddings via the shared EmbeddingService.
 * 4. Runs vector similarity search scoped to the target repository.
 * 5. Returns structured evidence with clickable GitHub source links and line anchors.
 * 6. Preserves objectivity — empty matches return [] and never claim the skill is absent.
 */

export class RepositoryNotIndexedError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepositoryNotIndexedError";
  }
}

export class EntityNotFoundError extends Error {
  constructor(message, entityType = "Entity") {
    super(message);
    this.name = "EntityNotFoundError";
    this.entityType = entityType;
  }
}

export class RequirementsNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "RequirementsNotFoundError";
  }
}

/**
 * Format line range string (e.g., "12-45" or "12").
 *
 * @param {number|null} startLine
 * @param {number|null} endLine
 * @returns {string|null}
 */
export function formatLineRange(startLine, endLine) {
  if (startLine == null && endLine == null) return null;
  if (startLine != null && endLine != null) {
    return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  }
  return `${startLine ?? endLine}`;
}

/**
 * Build a clickable GitHub source URL with a line anchor.
 *
 * @param {object} params
 * @param {string} params.htmlUrl Repository web base URL (e.g. "https://github.com/owner/repo")
 * @param {string} [params.commitSha] Commit SHA
 * @param {string} params.filePath Relative path in repo
 * @param {number|null} [params.startLine]
 * @param {number|null} [params.endLine]
 * @returns {string|null}
 */
export function buildSourceUrl({ htmlUrl, commitSha, filePath, startLine, endLine }) {
  if (!htmlUrl || !filePath) return null;

  const base = htmlUrl.replace(/\/+$/, "");
  const cleanPath = filePath.replace(/^\/+/, "");
  const ref = commitSha || "main";
  let url = `${base}/blob/${ref}/${cleanPath}`;

  if (startLine != null && endLine != null) {
    if (startLine === endLine) {
      url += `#L${startLine}`;
    } else {
      url += `#L${startLine}-L${endLine}`;
    }
  } else if (startLine != null) {
    url += `#L${startLine}`;
  }

  return url;
}

/**
 * Formulate rich query text from requirement fields.
 *
 * @param {object} req
 * @returns {string}
 */
export function formatRequirementQuery(req) {
  const parts = [];
  if (req.skill) parts.push(req.skill);
  if (req.description) parts.push(req.description);
  if (Array.isArray(req.evidence_hints) && req.evidence_hints.length > 0) {
    parts.push(`Hints: ${req.evidence_hints.join(", ")}`);
  }
  return parts.join(". ");
}

export class EvidenceService {
  /**
   * @param {object} options
   * @param {import('./embeddingService.js').EmbeddingService} options.embeddingService
   * @param {import('../repositories/evidenceRepository.js').EvidenceRepository} options.repository
   */
  constructor({ embeddingService, repository } = {}) {
    if (!embeddingService) throw new Error("embeddingService is required");
    if (!repository) throw new Error("repository is required");

    this.embeddingService = embeddingService;
    this.repository = repository;
  }

  /**
   * Retrieve code evidence for requirements.
   *
   * @param {object} params
   * @param {string} [params.jobPostingId]
   * @param {string} [params.assessmentId]
   * @param {string} [params.repositoryId]
   * @param {string} [params.owner]
   * @param {string} [params.name]
   * @param {number} [params.matchCount=5]
   * @param {number} [params.similarityThreshold=0.5]
   * @returns {Promise<object>}
   */
  async retrieveEvidence({
    jobPostingId,
    assessmentId,
    repositoryId,
    owner,
    name,
    matchCount = 5,
    similarityThreshold = 0.5,
  } = {}) {
    let resolvedPostingId = jobPostingId;
    let resolvedRepoId = repositoryId;
    let assessment = null;

    // 1. Resolve from assessment if assessmentId is provided
    if (assessmentId) {
      assessment = await this.repository.getAssessmentById(assessmentId);
      if (!assessment) {
        throw new EntityNotFoundError(`Assessment with ID '${assessmentId}' was not found.`, "Assessment");
      }
      if (!resolvedPostingId) {
        resolvedPostingId = assessment.job_posting_id;
      }
      if (!resolvedRepoId && assessment.repository_id) {
        resolvedRepoId = assessment.repository_id;
      }
    }

    if (!resolvedPostingId) {
      throw new Error("jobPostingId could not be resolved");
    }

    // 2. Fetch and verify job posting
    const jobPosting = await this.repository.getJobPostingById(resolvedPostingId);
    if (!jobPosting) {
      throw new EntityNotFoundError(`Job posting with ID '${resolvedPostingId}' was not found.`, "JobPosting");
    }

    // 3. Resolve and verify repository
    let repo = null;
    if (resolvedRepoId) {
      repo = await this.repository.getRepositoryById(resolvedRepoId);
    } else if (owner && name) {
      repo = await this.repository.getRepositoryByOwnerAndName(owner, name);
    }

    if (!repo) {
      const identifier = resolvedRepoId || `${owner}/${name}`;
      throw new EntityNotFoundError(
        `Repository '${identifier}' was not found in indexed repositories.`,
        "Repository"
      );
    }

    // 4. Verify repository indexing state
    const indexState = await this.repository.getRepositoryIndexState(repo.id);
    const chunkCount = await this.repository.getChunkCount(repo.id);

    if (!indexState || !indexState.indexed_commit_sha || indexState.status !== "idle" || chunkCount === 0) {
      const statusDesc = indexState ? indexState.status : "not indexed";
      throw new RepositoryNotIndexedError(
        `Repository '${repo.full_name || `${repo.owner}/${repo.name}`}' has not completed indexing (status: ${statusDesc}, chunks: ${chunkCount}). Please ingest the repository first.`
      );
    }

    // 5. Load requirements for the job posting
    const requirements = await this.repository.getRequirementsByPostingId(resolvedPostingId);
    if (!requirements || requirements.length === 0) {
      throw new RequirementsNotFoundError(
        `No requirements found for job posting '${resolvedPostingId}'. Please extract requirements first.`
      );
    }

    // 6. Generate query embeddings for requirements in batch
    const queryTexts = requirements.map((req) => formatRequirementQuery(req));
    const queryEmbeddings = await this.embeddingService.embedTexts(queryTexts);

    // 7. For each requirement, search code chunks scoped to this repository
    const structuredEvidence = [];
    const targetCommitSha = indexState.indexed_commit_sha;

    for (let i = 0; i < requirements.length; i++) {
      const req = requirements[i];
      const embedding = queryEmbeddings[i];

      const rawChunks = await this.repository.matchCodeChunks({
        queryEmbedding: embedding,
        matchThreshold: similarityThreshold,
        matchCount,
        repositoryId: repo.id,
        embeddingModel: this.embeddingService.model,
      });

      const matches = (rawChunks || []).map((chunk) => {
        const startLine = chunk.start_line ?? null;
        const endLine = chunk.end_line ?? null;
        const commitSha = chunk.commit_sha || targetCommitSha;

        return {
          chunkId: chunk.id ?? chunk.chunk_id,
          similarity: typeof chunk.similarity === "number" ? Number(chunk.similarity.toFixed(4)) : chunk.similarity,
          repositoryName: repo.full_name || `${repo.owner}/${repo.name}`,
          filePath: chunk.file_path,
          startLine,
          endLine,
          lineRange: formatLineRange(startLine, endLine),
          content: chunk.content,
          sourceUrl: buildSourceUrl({
            htmlUrl: repo.html_url,
            commitSha,
            filePath: chunk.file_path,
            startLine,
            endLine,
          }),
        };
      });

      structuredEvidence.push({
        requirementId: req.id,
        requirementKey: req.requirement_key,
        skill: req.skill,
        description: req.description,
        evidenceHints: req.evidence_hints || [],
        sourceExcerpt: req.source_excerpt,
        evidence: matches, // Empty array if no matching chunks found; never claims skill is absent
      });
    }

    return {
      jobPostingId: resolvedPostingId,
      ...(assessment ? { assessmentId: assessment.id } : {}),
      repository: {
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.full_name || `${repo.owner}/${repo.name}`,
        htmlUrl: repo.html_url,
        indexedCommitSha: targetCommitSha,
      },
      retrievalConfig: {
        matchCount,
        similarityThreshold,
      },
      requirementsCount: requirements.length,
      evidence: structuredEvidence,
    };
  }
}
