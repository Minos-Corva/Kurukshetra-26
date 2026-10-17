/**
 * evidence.test.js
 *
 * Automated tests for Feature 6: Evidence Retrieval.
 * Covers:
 *  - Retrieval by jobPostingId + repositoryId
 *  - Retrieval by assessmentId (auto-resolving posting & repo)
 *  - Retrieval with repository scope by owner + name
 *  - GitHub source URL generation with exact line anchors
 *  - Line range formatting (single line, range, null)
 *  - Configurable matchCount and similarityThreshold
 *  - Empty evidence list on non-matching chunks (never claiming skill is absent)
 *  - Strict repository scoping (rejecting unrelated repositories)
 *  - Unindexed repository detection and clear error responses
 *  - Missing entity handling (job posting, assessment, repository, requirements)
 *  - Zod request validation
 *  - Safe error responses for database and embedding failures
 *  - RPC parameter fallback compatibility (deployed p_* signature vs legacy signatures)
 *
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceRepository } from "./repositories/evidenceRepository.js";
import {
  EvidenceService,
  formatLineRange,
  buildSourceUrl,
  formatRequirementQuery,
} from "./services/evidenceService.js";
import { EvidenceController } from "./controllers/evidenceController.js";

// ---------------------------------------------------------------------------
// Helpers and Mocks
// ---------------------------------------------------------------------------

function makeMockResponse() {
  let statusCode = 200;
  let body = null;
  return {
    status: (code) => {
      statusCode = code;
      return {
        json: (data) => {
          body = data;
        },
      };
    },
    json: (data) => {
      body = data;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
}

function makeMockEmbeddingService({ shouldFail = false } = {}) {
  return {
    model: "jinaai/jina-embeddings-v2-base-code",
    embedTexts: async (texts) => {
      if (shouldFail) {
        throw new Error("Embedding model execution failed");
      }
      return texts.map(() => new Array(768).fill(1 / Math.sqrt(768)));
    },
  };
}

function makeMockSupabase({
  postings = [],
  requirements = [],
  assessments = [],
  repositories = [],
  indexStates = [],
  codeChunks = [],
  rpcHandler = null,
  failOn = null,
} = {}) {
  const store = {
    job_postings: [...postings],
    requirements: [...requirements],
    assessments: [...assessments],
    repositories: [...repositories],
    repository_index_state: [...indexStates],
    code_chunks: [...codeChunks],
  };

  return {
    _store: store,
    from: (table) => {
      if (failOn === `${table}_query`) {
        return {
          select: () => {
            throw new Error(`Database error querying ${table}`);
          },
        };
      }

      return {
        select: (_cols, opts = {}) => {
          let rows = [...(store[table] || [])];
          let filtered = rows;

          const query = {
            eq: (col, val) => {
              filtered = filtered.filter((r) => r[col] === val);
              return query;
            },
            order: (col, { ascending = true } = {}) => {
              filtered.sort((a, b) => {
                if (a[col] < b[col]) return ascending ? -1 : 1;
                if (a[col] > b[col]) return ascending ? 1 : -1;
                return 0;
              });
              return query;
            },
            maybeSingle: async () => {
              if (failOn === `${table}_single`) {
                return { data: null, error: new Error(`${table} query failed`) };
              }
              return { data: filtered[0] || null, error: null };
            },
            single: async () => {
              return { data: filtered[0] || null, error: null };
            },
            then: (resolve) => {
              resolve({ data: filtered, error: null });
            },
          };

          if (opts.head) {
            return {
              eq: (col, val) => {
                const count = (store[table] || []).filter((r) => r[col] === val).length;
                return Promise.resolve({ count, error: null });
              },
            };
          }

          return query;
        },
      };
    },
    rpc: async (fnName, params) => {
      if (failOn === "rpc") {
        return { data: null, error: new Error("RPC match_code_chunks execution failed") };
      }
      if (rpcHandler) {
        return rpcHandler(fnName, params);
      }
      // Default match_code_chunks mock: returns chunks for matching repository with similarity.
      // Supports the deployed 4-arg signature (p_*) and the legacy signature.
      const targetRepoId =
        params.p_repository_id || params.filter_repository_id || params.repository_id;
      const requestedCount = params.p_match_count || params.match_count || 5;
      const matched = store.code_chunks
        .filter((c) => !targetRepoId || c.repository_id === targetRepoId)
        .slice(0, requestedCount)
        .map((c, idx) => ({
          ...c,
          similarity: 0.9 - idx * 0.05,
        }));
      return { data: matched, error: null };
    },
  };
}

// ---------------------------------------------------------------------------
// Seed Data
// ---------------------------------------------------------------------------

const SAMPLE_POSTING = {
  id: "11111111-1111-4111-8111-111111111111",
  source_url: "https://example.com/jobs/1",
  raw_text: "Backend Developer needed with Node.js and PostgreSQL experience",
  fetched_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

const SAMPLE_REQUIREMENTS = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    job_posting_id: "11111111-1111-4111-8111-111111111111",
    requirement_key: "req_1",
    skill: "Node.js",
    description: "Experience building REST APIs with Express",
    evidence_hints: ["express", "app.use", "router"],
    source_excerpt: "Node.js and Express API experience",
    sort_order: 0,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    job_posting_id: "11111111-1111-4111-8111-111111111111",
    requirement_key: "req_2",
    skill: "PostgreSQL",
    description: "Database modeling and pgvector similarity queries",
    evidence_hints: ["pgvector", "sql", "migrations"],
    source_excerpt: "PostgreSQL experience required",
    sort_order: 1,
  },
];

const SAMPLE_REPO = {
  id: "44444444-4444-4444-8444-444444444444",
  owner: "testowner",
  name: "testrepo",
  full_name: "testowner/testrepo",
  html_url: "https://github.com/testowner/testrepo",
  default_branch: "main",
  created_at: new Date().toISOString(),
};

const SAMPLE_INDEX_STATE = {
  repository_id: "44444444-4444-4444-8444-444444444444",
  indexed_commit_sha: "commit-sha-abc-123",
  latest_seen_commit_sha: "commit-sha-abc-123",
  status: "idle",
  last_success_at: new Date().toISOString(),
  last_error: null,
};

const SAMPLE_CHUNKS = [
  {
    id: "chunk-node-1",
    repository_id: "44444444-4444-4444-8444-444444444444",
    file_path: "src/server.js",
    chunk_index: 0,
    content: "import express from 'express';\nconst app = express();",
    start_line: 1,
    end_line: 25,
    commit_sha: "commit-sha-abc-123",
  },
  {
    id: "chunk-pg-1",
    repository_id: "44444444-4444-4444-8444-444444444444",
    file_path: "src/db.js",
    chunk_index: 0,
    content: "import { createClient } from '@supabase/supabase-js';",
    start_line: 10,
    end_line: 30,
    commit_sha: "commit-sha-abc-123",
  },
];

const SAMPLE_ASSESSMENT = {
  id: "55555555-5555-4555-8555-555555555555",
  job_posting_id: "11111111-1111-4111-8111-111111111111",
  repository_id: "44444444-4444-4444-8444-444444444444",
  commit_sha: "commit-sha-abc-123",
  model_name: "qwen/qwen3.8-27b",
  created_at: new Date().toISOString(),
};

// ===========================================================================
// Test Suite: Evidence Retrieval
// ===========================================================================

test("Requirement 1: Valid retrieval with jobPostingId + repositoryId returns structured evidence with clickable URLs and anchors", async () => {
  const supabase = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: SAMPLE_REQUIREMENTS,
    repositories: [SAMPLE_REPO],
    indexStates: [SAMPLE_INDEX_STATE],
    codeChunks: SAMPLE_CHUNKS,
  });

  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  const req = {
    body: {
      jobPostingId: SAMPLE_POSTING.id,
      repositoryId: SAMPLE_REPO.id,
      matchCount: 3,
      similarityThreshold: 0.6,
    },
  };
  const res = makeMockResponse();

  await controller.retrieve(req, res);

  assert.strictEqual(res.getStatusCode(), 200);
  const body = res.getBody();

  assert.strictEqual(body.jobPostingId, SAMPLE_POSTING.id);
  assert.strictEqual(body.repository.id, SAMPLE_REPO.id);
  assert.strictEqual(body.repository.fullName, "testowner/testrepo");
  assert.strictEqual(body.requirementsCount, 2);
  assert.strictEqual(body.evidence.length, 2);

  const req1Evidence = body.evidence[0];
  assert.strictEqual(req1Evidence.requirementKey, "req_1");
  assert.strictEqual(req1Evidence.skill, "Node.js");
  assert.ok(req1Evidence.evidence.length > 0);

  const match = req1Evidence.evidence[0];
  assert.ok(match.chunkId);
  assert.strictEqual(match.repositoryName, "testowner/testrepo");
  assert.strictEqual(match.filePath, "src/server.js");
  assert.strictEqual(match.startLine, 1);
  assert.strictEqual(match.endLine, 25);
  assert.strictEqual(match.lineRange, "1-25");
  assert.strictEqual(
    match.sourceUrl,
    "https://github.com/testowner/testrepo/blob/commit-sha-abc-123/src/server.js#L1-L25"
  );
  assert.ok(typeof match.similarity === "number");
  assert.ok(match.content.includes("express"));
});

test("Requirement 2: Valid retrieval by assessmentId resolves posting and repository automatically", async () => {
  const supabase = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: SAMPLE_REQUIREMENTS,
    assessments: [SAMPLE_ASSESSMENT],
    repositories: [SAMPLE_REPO],
    indexStates: [SAMPLE_INDEX_STATE],
    codeChunks: SAMPLE_CHUNKS,
  });

  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  const req = {
    body: {
      assessmentId: SAMPLE_ASSESSMENT.id,
    },
  };
  const res = makeMockResponse();

  await controller.retrieve(req, res);

  assert.strictEqual(res.getStatusCode(), 200);
  const body = res.getBody();
  assert.strictEqual(body.assessmentId, SAMPLE_ASSESSMENT.id);
  assert.strictEqual(body.jobPostingId, SAMPLE_POSTING.id);
  assert.strictEqual(body.repository.id, SAMPLE_REPO.id);
  assert.strictEqual(body.evidence.length, 2);
});

test("Requirement 3: Valid retrieval with repository scope by owner + name", async () => {
  const supabase = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: SAMPLE_REQUIREMENTS,
    repositories: [SAMPLE_REPO],
    indexStates: [SAMPLE_INDEX_STATE],
    codeChunks: SAMPLE_CHUNKS,
  });

  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  const req = {
    body: {
      jobPostingId: SAMPLE_POSTING.id,
      owner: "testowner",
      name: "testrepo",
    },
  };
  const res = makeMockResponse();

  await controller.retrieve(req, res);

  assert.strictEqual(res.getStatusCode(), 200);
  const body = res.getBody();
  assert.strictEqual(body.repository.owner, "testowner");
  assert.strictEqual(body.repository.name, "testrepo");
});

test("Requirement 4: GitHub source URL helper formats single line, multi-line, and null line anchors properly", () => {
  const multiLineUrl = buildSourceUrl({
    htmlUrl: "https://github.com/foo/bar",
    commitSha: "sha123",
    filePath: "src/main.py",
    startLine: 10,
    endLine: 25,
  });
  assert.strictEqual(multiLineUrl, "https://github.com/foo/bar/blob/sha123/src/main.py#L10-L25");

  const singleLineUrl = buildSourceUrl({
    htmlUrl: "https://github.com/foo/bar",
    commitSha: "sha123",
    filePath: "src/main.py",
    startLine: 42,
    endLine: 42,
  });
  assert.strictEqual(singleLineUrl, "https://github.com/foo/bar/blob/sha123/src/main.py#L42");

  const noLineUrl = buildSourceUrl({
    htmlUrl: "https://github.com/foo/bar",
    commitSha: "sha123",
    filePath: "README.md",
    startLine: null,
    endLine: null,
  });
  assert.strictEqual(noLineUrl, "https://github.com/foo/bar/blob/sha123/README.md");

  // formatLineRange tests
  assert.strictEqual(formatLineRange(10, 25), "10-25");
  assert.strictEqual(formatLineRange(42, 42), "42");
  assert.strictEqual(formatLineRange(null, null), null);

  // formatRequirementQuery tests
  const queryText = formatRequirementQuery({
    skill: "React",
    description: "Component state management",
    evidence_hints: ["useState", "useEffect"],
  });
  assert.ok(queryText.includes("React"));
  assert.ok(queryText.includes("Component state management"));
  assert.ok(queryText.includes("Hints: useState, useEffect"));
});

test("Requirement 5: matchCount is forwarded to the RPC and similarityThreshold filters the returned matches", async () => {
  let capturedParams = null;
  const supabase = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: [SAMPLE_REQUIREMENTS[0]],
    repositories: [SAMPLE_REPO],
    indexStates: [SAMPLE_INDEX_STATE],
    codeChunks: SAMPLE_CHUNKS,
    rpcHandler: (fnName, params) => {
      capturedParams = params;
      // Two matches: one above the 0.85 threshold, one below it.
      return {
        data: [
          { ...SAMPLE_CHUNKS[0], similarity: 0.9 },
          { ...SAMPLE_CHUNKS[1], similarity: 0.6 },
        ],
        error: null,
      };
    },
  });

  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  const req = {
    body: {
      jobPostingId: SAMPLE_POSTING.id,
      repositoryId: SAMPLE_REPO.id,
      matchCount: 7,
      similarityThreshold: 0.85,
    },
  };
  const res = makeMockResponse();

  await controller.retrieve(req, res);

  assert.strictEqual(res.getStatusCode(), 200);

  // Deployed signature: p_match_count / p_repository_id / p_embedding_model
  assert.strictEqual(capturedParams.p_match_count, 7);
  assert.strictEqual(capturedParams.p_repository_id, SAMPLE_REPO.id);
  assert.strictEqual(capturedParams.p_embedding_model, embeddingService.model);

  // Threshold is applied client-side (deployed RPC has no threshold argument)
  const matches = res.getBody().evidence[0].evidence;
  assert.strictEqual(matches.length, 1);
  assert.ok(matches[0].similarity >= 0.85);
});

test("Requirement 6: Requirement with no matching code returns empty evidence list without claiming skill is absent", async () => {
  const supabase = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: [SAMPLE_REQUIREMENTS[0]],
    repositories: [SAMPLE_REPO],
    indexStates: [SAMPLE_INDEX_STATE],
    codeChunks: SAMPLE_CHUNKS,
    rpcHandler: () => ({ data: [], error: null }), // Empty search results
  });

  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  const req = {
    body: {
      jobPostingId: SAMPLE_POSTING.id,
      repositoryId: SAMPLE_REPO.id,
    },
  };
  const res = makeMockResponse();

  await controller.retrieve(req, res);

  assert.strictEqual(res.getStatusCode(), 200);
  const body = res.getBody();
  assert.strictEqual(body.evidence.length, 1);
  assert.deepStrictEqual(body.evidence[0].evidence, []);
  // Verifies no verdict or claim of absence is injected
  assert.strictEqual("status" in body.evidence[0], false);
  assert.strictEqual("verdict" in body.evidence[0], false);
});

test("Requirement 7: Search is scoped to the target repository and avoids returning unrelated users' repository data", async () => {
  const otherRepoChunk = {
    id: "chunk-other-user",
    repository_id: "99999999-9999-4999-8999-999999999999", // Unrelated repo
    file_path: "secret/passwords.txt",
    chunk_index: 0,
    content: "super_secret_credentials",
    start_line: 1,
    end_line: 1,
    commit_sha: "other-commit",
  };

  const supabase = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: [SAMPLE_REQUIREMENTS[0]],
    repositories: [SAMPLE_REPO],
    indexStates: [SAMPLE_INDEX_STATE],
    codeChunks: [SAMPLE_CHUNKS[0], otherRepoChunk],
    // RPC improperly returns both, repository should filter out other repository's chunk
    rpcHandler: (_fn, params) => {
      const repoId =
        params.p_repository_id || params.filter_repository_id || params.repository_id;
      void repoId;
      return {
        data: [
          { ...SAMPLE_CHUNKS[0], similarity: 0.9 },
          { ...otherRepoChunk, similarity: 0.95 },
        ],
        error: null,
      };
    },
  });

  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  const req = {
    body: {
      jobPostingId: SAMPLE_POSTING.id,
      repositoryId: SAMPLE_REPO.id,
    },
  };
  const res = makeMockResponse();

  await controller.retrieve(req, res);

  assert.strictEqual(res.getStatusCode(), 200);
  const matches = res.getBody().evidence[0].evidence;
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].chunkId, "chunk-node-1");
  assert.strictEqual(matches[0].filePath, "src/server.js");
});

test("Requirement 8: Repository that has not been indexed returns 422 with a clear, useful response", async () => {
  // Case A: Index state is null or status is running
  const unindexedState = {
    repository_id: SAMPLE_REPO.id,
    indexed_commit_sha: null,
    status: "running",
  };

  const supabase = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: SAMPLE_REQUIREMENTS,
    repositories: [SAMPLE_REPO],
    indexStates: [unindexedState],
    codeChunks: [],
  });

  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  const req = {
    body: {
      jobPostingId: SAMPLE_POSTING.id,
      repositoryId: SAMPLE_REPO.id,
    },
  };
  const res = makeMockResponse();

  await controller.retrieve(req, res);

  assert.strictEqual(res.getStatusCode(), 422);
  const body = res.getBody();
  assert.strictEqual(body.error, "Repository not indexed");
  assert.ok(body.message.includes("has not completed indexing"));
});

test("Requirement 9: Nonexistent job posting, assessment, or repository returns 404", async () => {
  const supabase = makeMockSupabase({
    postings: [],
    requirements: [],
    repositories: [],
  });

  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  // 1. Missing job posting
  const res1 = makeMockResponse();
  await controller.retrieve(
    { body: { jobPostingId: "99999999-9999-4999-8999-999999999999", repositoryId: SAMPLE_REPO.id } },
    res1
  );
  assert.strictEqual(res1.getStatusCode(), 404);
  assert.strictEqual(res1.getBody().error, "JobPosting not found");

  // 2. Missing assessment
  const res2 = makeMockResponse();
  await controller.retrieve(
    { body: { assessmentId: "99999999-9999-4999-8999-999999999999" } },
    res2
  );
  assert.strictEqual(res2.getStatusCode(), 404);
  assert.strictEqual(res2.getBody().error, "Assessment not found");

  // 3. Missing repository
  const supabaseWithPosting = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: SAMPLE_REQUIREMENTS,
    repositories: [],
  });
  const repoWithPosting = new EvidenceRepository({ supabaseClient: supabaseWithPosting });
  const svcWithPosting = new EvidenceService({ embeddingService, repository: repoWithPosting });
  const ctrlWithPosting = new EvidenceController({ evidenceService: svcWithPosting });

  const res3 = makeMockResponse();
  await ctrlWithPosting.retrieve(
    { body: { jobPostingId: SAMPLE_POSTING.id, repositoryId: "99999999-9999-4999-8999-999999999999" } },
    res3
  );
  assert.strictEqual(res3.getStatusCode(), 404);
  assert.strictEqual(res3.getBody().error, "Repository not found");
});

test("Requirement 10: Job posting with no extracted requirements returns 404", async () => {
  const supabase = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: [], // Empty requirements
    repositories: [SAMPLE_REPO],
    indexStates: [SAMPLE_INDEX_STATE],
    codeChunks: SAMPLE_CHUNKS,
  });

  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  const req = {
    body: {
      jobPostingId: SAMPLE_POSTING.id,
      repositoryId: SAMPLE_REPO.id,
    },
  };
  const res = makeMockResponse();

  await controller.retrieve(req, res);

  assert.strictEqual(res.getStatusCode(), 404);
  assert.strictEqual(res.getBody().error, "Requirements not found");
});

test("Requirement 11: Input validation rejects invalid UUIDs, missing IDs, or missing repository scope", async () => {
  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: makeMockSupabase() });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  // Case 1: No IDs at all
  const res1 = makeMockResponse();
  await controller.retrieve({ body: {} }, res1);
  assert.strictEqual(res1.getStatusCode(), 400);
  assert.strictEqual(res1.getBody().error, "Invalid input");

  // Case 2: Invalid UUID format
  const res2 = makeMockResponse();
  await controller.retrieve({ body: { jobPostingId: "not-a-uuid", repositoryId: "not-a-uuid" } }, res2);
  assert.strictEqual(res2.getStatusCode(), 400);

  // Case 3: jobPostingId provided but repository scope missing
  const res3 = makeMockResponse();
  await controller.retrieve({ body: { jobPostingId: SAMPLE_POSTING.id } }, res3);
  assert.strictEqual(res3.getStatusCode(), 400);
  assert.ok(res3.getBody().details.some((d) => d.includes("Repository scope")));

  // Case 4: Invalid matchCount
  const res4 = makeMockResponse();
  await controller.retrieve(
    { body: { jobPostingId: SAMPLE_POSTING.id, repositoryId: SAMPLE_REPO.id, matchCount: -5 } },
    res4
  );
  assert.strictEqual(res4.getStatusCode(), 400);
});

test("Requirement 12: Embedding failure returns 500 without leaking secrets or internals", async () => {
  const supabase = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: SAMPLE_REQUIREMENTS,
    repositories: [SAMPLE_REPO],
    indexStates: [SAMPLE_INDEX_STATE],
    codeChunks: SAMPLE_CHUNKS,
  });

  const embeddingService = makeMockEmbeddingService({ shouldFail: true });
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  const res = makeMockResponse();
  await controller.retrieve(
    { body: { jobPostingId: SAMPLE_POSTING.id, repositoryId: SAMPLE_REPO.id } },
    res
  );

  assert.strictEqual(res.getStatusCode(), 500);
  assert.strictEqual(res.getBody().error, "Embedding error");
});

test("Requirement 13: Database failure returns 500 without leaking database credentials", async () => {
  const supabase = makeMockSupabase({
    postings: [SAMPLE_POSTING],
    requirements: SAMPLE_REQUIREMENTS,
    repositories: [SAMPLE_REPO],
    indexStates: [SAMPLE_INDEX_STATE],
    codeChunks: SAMPLE_CHUNKS,
    failOn: "rpc",
  });

  const embeddingService = makeMockEmbeddingService();
  const repository = new EvidenceRepository({ supabaseClient: supabase });
  const evidenceService = new EvidenceService({ embeddingService, repository });
  const controller = new EvidenceController({ evidenceService });

  const res = makeMockResponse();
  await controller.retrieve(
    { body: { jobPostingId: SAMPLE_POSTING.id, repositoryId: SAMPLE_REPO.id } },
    res
  );

  assert.strictEqual(res.getStatusCode(), 500);
  assert.strictEqual(res.getBody().error, "Database error");
});

test("Requirement 14: Uses the deployed match_code_chunks signature, normalizes chunk_id, and falls back to legacy signatures", async () => {
  // Part A: deployed 4-arg signature is used and chunk_id is normalized to id.
  const calls = [];
  const deployedSupabase = {
    rpc: async (_fn, params) => {
      calls.push(params);
      return {
        data: [
          {
            chunk_id: "deployed-chunk-1",
            file_path: "src/app.js",
            start_line: 5,
            end_line: 9,
            commit_sha: "sha-deployed",
            content: "const app = express();",
            similarity: 0.77,
          },
        ],
        error: null,
      };
    },
  };

  const deployedRepo = new EvidenceRepository({ supabaseClient: deployedSupabase });
  const deployedResults = await deployedRepo.matchCodeChunks({
    queryEmbedding: new Array(768).fill(0.1),
    matchThreshold: 0.5,
    matchCount: 5,
    repositoryId: SAMPLE_REPO.id,
    embeddingModel: "jinaai/jina-embeddings-v2-base-code",
  });

  assert.strictEqual(deployedResults.length, 1);
  assert.strictEqual(deployedResults[0].id, "deployed-chunk-1");
  assert.strictEqual(deployedResults[0].chunk_id, "deployed-chunk-1");
  assert.strictEqual(calls.length, 1);
  assert.ok("p_query_embedding" in calls[0]);
  assert.strictEqual(calls[0].p_repository_id, SAMPLE_REPO.id);
  assert.strictEqual(calls[0].p_embedding_model, "jinaai/jina-embeddings-v2-base-code");
  assert.strictEqual(calls[0].p_match_count, 5);

  // Part B: if the deployed function is unavailable, legacy signatures are tried in order.
  const fallbackCalls = [];
  const legacySupabase = {
    rpc: async (_fn, params) => {
      fallbackCalls.push(params);
      if ("p_query_embedding" in params) {
        const err = new Error(
          "Could not find the function public.match_code_chunks(p_repository_id, p_embedding_model, p_query_embedding, p_match_count) in the schema cache"
        );
        err.code = "PGRST202";
        return { data: null, error: err };
      }
      if ("filter_repository_id" in params) {
        return { data: null, error: new Error("parameter filter_repository_id does not exist") };
      }
      return { data: [{ ...SAMPLE_CHUNKS[0], similarity: 0.88 }], error: null };
    },
  };

  const legacyRepo = new EvidenceRepository({ supabaseClient: legacySupabase });
  const legacyResults = await legacyRepo.matchCodeChunks({
    queryEmbedding: new Array(768).fill(0.1),
    matchThreshold: 0.5,
    matchCount: 5,
    repositoryId: SAMPLE_REPO.id,
    embeddingModel: "jinaai/jina-embeddings-v2-base-code",
  });

  assert.strictEqual(legacyResults.length, 1);
  assert.strictEqual(fallbackCalls.length, 3);
  assert.ok("p_query_embedding" in fallbackCalls[0]);
  assert.ok("filter_repository_id" in fallbackCalls[1]);
  assert.ok("repository_id" in fallbackCalls[2]);
});
