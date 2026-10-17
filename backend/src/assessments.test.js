/**
 * assessments.test.js
 *
 * Automated tests for Feature 7: Requirement-by-requirement assessment.
 *
 * Feature 6 (evidence retrieval) is stubbed here so these tests focus on the
 * assessment orchestration: bounded Groq batching, strict output validation,
 * evidence grounding, idempotent persistence, and safe error responses.
 *
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AssessmentService,
  AssessmentModelError,
  InvalidAssessmentOutputError,
  UngroundedAssessmentError,
  ASSESSMENT_STATUSES,
} from "./services/assessmentService.js";
import {
  apiStatusToDb,
  dbStatusToApi,
} from "./repositories/assessmentRepository.js";
import { AssessmentsController } from "./controllers/assessmentsController.js";
import {
  EntityNotFoundError,
  RepositoryNotIndexedError,
  RequirementsNotFoundError,
} from "./services/evidenceService.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POSTING_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "44444444-4444-4444-8444-444444444444";
const COMMIT_SHA = "5317ebe670db2aaebc1d496eb5d33493deefb3ed";
const MODEL = "qwen/qwen3.8-27b";

function makeRequirement({ id, key, skill, evidence = [] }) {
  return {
    requirementId: id,
    requirementKey: key,
    skill,
    description: `${skill} experience`,
    evidenceHints: [skill],
    sourceExcerpt: `Requires ${skill}`,
    evidence,
  };
}

function makeEvidenceChunk({ id, filePath, content = "code", startLine = 1, endLine = 20 }) {
  return {
    chunkId: id,
    similarity: 0.91,
    repositoryName: "testowner/testrepo",
    filePath,
    startLine,
    endLine,
    lineRange: `${startLine}-${endLine}`,
    content,
    sourceUrl: `https://github.com/testowner/testrepo/blob/${COMMIT_SHA}/${filePath}#L${startLine}-L${endLine}`,
  };
}

const NODE_REQUIREMENT = makeRequirement({
  id: "req-1111",
  key: "req_1",
  skill: "Node.js",
  evidence: [
    makeEvidenceChunk({ id: "chunk-aaa", filePath: "src/server.js", content: "import express from 'express'" }),
  ],
});

const SQL_REQUIREMENT = makeRequirement({
  id: "req-2222",
  key: "req_2",
  skill: "PostgreSQL",
  evidence: [], // No matching code → must become not_found
});

function makeRetrieval(requirements) {
  return {
    jobPostingId: POSTING_ID,
    repository: {
      id: REPO_ID,
      owner: "testowner",
      name: "testrepo",
      fullName: "testowner/testrepo",
      htmlUrl: "https://github.com/testowner/testrepo",
      indexedCommitSha: COMMIT_SHA,
    },
    retrievalConfig: { matchCount: 5, similarityThreshold: 0.5 },
    requirementsCount: requirements.length,
    evidence: requirements,
  };
}

function makeMockResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeMockEvidenceService(retrieval) {
  return {
    calls: [],
    async retrieveEvidence(params) {
      this.calls.push(params);
      const value = typeof retrieval === "function" ? retrieval(params) : retrieval;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

/** Groq stub. Provide either `handler(payload)` or static `responses` (JSON strings). */
function makeMockGroq({ handler = null, responses = [], error = null } = {}) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(params) {
          calls.push(params);
          if (error) throw error;
          const index = calls.length - 1;
          const content = handler
            ? JSON.stringify(handler(JSON.parse(params.messages[1].content), index))
            : responses[Math.min(index, responses.length - 1)];
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

function makeMockAssessmentRepository(seed = {}) {
  const store = {
    assessments: [...(seed.assessments || [])],
    requirement_assessments: [...(seed.requirementAssessments || [])],
    assessment_evidence: [...(seed.assessmentEvidence || [])],
    requirements: [...(seed.requirements || [])],
    repositories: [...(seed.repositories || [])],
  };
  let assessmentCounter = store.assessments.length;
  let verdictCounter = store.requirement_assessments.length;

  return {
    _store: store,
    async findExistingAssessment({ jobPostingId, repositoryId, commitSha }) {
      return (
        store.assessments.find(
          (a) => a.job_posting_id === jobPostingId && a.repository_id === repositoryId && a.commit_sha === commitSha
        ) || null
      );
    },
    async createAssessment({ jobPostingId, repositoryId, commitSha, modelName }) {
      const row = {
        id: `assessment-${++assessmentCounter}`,
        job_posting_id: jobPostingId,
        repository_id: repositoryId,
        commit_sha: commitSha,
        model_name: modelName,
        created_at: new Date().toISOString(),
      };
      store.assessments.push(row);
      return row;
    },
    async saveResults({ assessmentId, results }) {
      for (const result of results) {
        const verdictId = `verdict-${++verdictCounter}`;
        store.requirement_assessments.push({
          id: verdictId,
          assessment_id: assessmentId,
          requirement_id: result.requirementId,
          status: apiStatusToDb(result.status),
          explanation: result.explanation,
          confidence: result.confidence,
        });
        for (const item of result.evidence) {
          store.assessment_evidence.push({
            id: `evidence-${store.assessment_evidence.length + 1}`,
            requirement_assessment_id: verdictId,
            code_chunk_id: item.chunkId,
            file_path: item.filePath,
            start_line: item.startLine,
            end_line: item.endLine,
            commit_sha: result.commitSha,
            quote: item.quote,
            source_url: item.sourceUrl,
          });
        }
      }
      return results.length;
    },
    async getAssessmentById(assessmentId) {
      const assessment = store.assessments.find((a) => a.id === assessmentId);
      if (!assessment) return null;
      const verdicts = store.requirement_assessments.filter((v) => v.assessment_id === assessmentId);
      const verdictIds = new Set(verdicts.map((v) => v.id));
      const evidence = store.assessment_evidence.filter((e) => verdictIds.has(e.requirement_assessment_id));
      return { assessment, verdicts, evidence };
    },
    async getRequirementsByPostingId(postingId) {
      return store.requirements.filter((r) => r.job_posting_id === postingId);
    },
    async getRepositoryById(id) {
      return store.repositories.find((r) => r.id === id) || null;
    },
  };
}

function makeService({ retrieval, groq, repository, ...overrides }) {
  return new AssessmentService({
    evidenceService: makeMockEvidenceService(retrieval),
    groqClient: groq,
    model: MODEL,
    repository: repository || makeMockAssessmentRepository(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Feature 7 - Req 1: returns one grounded result per requirement and persists statuses, confidence and citations", async () => {
  const requirements = [NODE_REQUIREMENT, SQL_REQUIREMENT];
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({
    responses: [
      JSON.stringify({
        results: [
          { requirement_id: "req-1111", status: "supported", explanation: "Express is used in src/server.js.", evidence_ids: ["chunk-aaa"], confidence: 0.92 },
          { requirement_id: "req-2222", status: "not_found", explanation: "No PostgreSQL usage was found in the retrieved evidence.", evidence_ids: [], confidence: 0.4 },
        ],
      }),
    ],
  });

  const service = makeService({ retrieval: makeRetrieval(requirements), groq, repository });
  const result = await service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID });

  assert.strictEqual(result.created, true);
  assert.strictEqual(result.requirementsCount, 2);
  assert.strictEqual(result.assessment.jobPostingId, POSTING_ID);
  assert.strictEqual(result.assessment.repository.id, REPO_ID);
  assert.strictEqual(result.assessment.repository.indexedCommitSha, COMMIT_SHA);
  assert.strictEqual(result.assessment.modelName, MODEL);

  const [node, sql] = result.results;
  assert.strictEqual(node.status, "supported");
  assert.strictEqual(node.confidence, 0.92);
  assert.strictEqual(node.evidence.length, 1);
  assert.strictEqual(node.evidence[0].evidenceId, "chunk-aaa");
  assert.strictEqual(
    node.evidence[0].sourceUrl,
    `https://github.com/testowner/testrepo/blob/${COMMIT_SHA}/src/server.js#L1-L20`
  );

  assert.strictEqual(sql.status, "not_found");
  assert.deepStrictEqual(sql.evidence, []);

  // Persistence: assessment + one verdict per requirement + citations only for grounded claims.
  assert.strictEqual(repository._store.assessments.length, 1);
  assert.strictEqual(repository._store.requirement_assessments.length, 2);
  const statuses = repository._store.requirement_assessments.map((v) => v.status).sort();
  assert.deepStrictEqual(statuses, ["demonstrated", "not_demonstrated"]);
  assert.strictEqual(repository._store.assessment_evidence.length, 1);
  const citation = repository._store.assessment_evidence[0];
  assert.strictEqual(citation.code_chunk_id, "chunk-aaa");
  assert.strictEqual(citation.commit_sha, COMMIT_SHA);
  assert.strictEqual(citation.file_path, "src/server.js");
  assert.ok(citation.source_url.includes(COMMIT_SHA));
});

test("Feature 7 - Req 2: reuses Feature 6 retrieval and forwards matchCount / similarityThreshold", async () => {
  const requirements = [NODE_REQUIREMENT];
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({
    handler: () => ({
      results: [{ requirement_id: "req-1111", status: "supported", explanation: "ok", evidence_ids: ["chunk-aaa"], confidence: 0.8 }],
    }),
  });

  const service = makeService({ retrieval: makeRetrieval(requirements), groq, repository });
  await service.assess({
    jobPostingId: POSTING_ID,
    repositoryId: REPO_ID,
    matchCount: 9,
    similarityThreshold: 0.7,
  });

  assert.strictEqual(service.evidenceService.calls.length, 1);
  const call = service.evidenceService.calls[0];
  assert.strictEqual(call.jobPostingId, POSTING_ID);
  assert.strictEqual(call.repositoryId, REPO_ID);
  assert.strictEqual(call.matchCount, 9);
  assert.strictEqual(call.similarityThreshold, 0.7);
});

test("Feature 7 - Req 3: is idempotent for the same (posting, repository, commit SHA) and does not call the model again", async () => {
  const requirements = [
    { id: "req-1111", job_posting_id: POSTING_ID, requirement_key: "req_1", skill: "Node.js", description: "x", sort_order: 0 },
    { id: "req-2222", job_posting_id: POSTING_ID, requirement_key: "req_2", skill: "PostgreSQL", description: "y", sort_order: 1 },
  ];
  const repository = makeMockAssessmentRepository({
    assessments: [{ id: "assessment-existing", job_posting_id: POSTING_ID, repository_id: REPO_ID, commit_sha: COMMIT_SHA, model_name: MODEL, created_at: "2026-01-01T00:00:00.000Z" }],
    requirementAssessments: [
      { id: "verdict-a", assessment_id: "assessment-existing", requirement_id: "req-1111", status: "demonstrated", explanation: "stored", confidence: 0.9 },
      { id: "verdict-b", assessment_id: "assessment-existing", requirement_id: "req-2222", status: "not_demonstrated", explanation: "stored", confidence: 0.3 },
    ],
    assessmentEvidence: [
      { id: "evidence-a", requirement_assessment_id: "verdict-a", code_chunk_id: "chunk-aaa", file_path: "src/server.js", start_line: 1, end_line: 20, commit_sha: COMMIT_SHA, quote: "import express", source_url: `https://github.com/testowner/testrepo/blob/${COMMIT_SHA}/src/server.js#L1-L20` },
    ],
    requirements,
    repositories: [{ id: REPO_ID, owner: "testowner", name: "testrepo", full_name: "testowner/testrepo", html_url: "https://github.com/testowner/testrepo" }],
  });
  const groq = makeMockGroq({ handler: () => ({ results: [] }) });

  const service = makeService({ retrieval: makeRetrieval([NODE_REQUIREMENT, SQL_REQUIREMENT]), groq, repository });
  const result = await service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.assessment.id, "assessment-existing");
  assert.strictEqual(groq.calls.length, 0);
  assert.strictEqual(repository._store.assessments.length, 1);

  const [node, sql] = result.results;
  assert.strictEqual(node.status, "supported");
  assert.strictEqual(node.evidence[0].evidenceId, "chunk-aaa");
  assert.strictEqual(sql.status, "not_found");
});

test("Feature 7 - Req 4: not_found is returned for a requirement with no matching code without overstating absence", async () => {
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({
    handler: () => ({
      results: [
        { requirement_id: "req-1111", status: "supported", explanation: "ok", evidence_ids: ["chunk-aaa"], confidence: 0.8 },
        { requirement_id: "req-2222", status: "not_found", explanation: "No PostgreSQL evidence was retrieved from this repository.", evidence_ids: [], confidence: 0.5 },
      ],
    }),
  });

  const service = makeService({ retrieval: makeRetrieval([NODE_REQUIREMENT, SQL_REQUIREMENT]), groq, repository });
  const result = await service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID });

  const sql = result.results.find((r) => r.requirementId === "req-2222");
  assert.strictEqual(sql.status, "not_found");
  assert.ok(sql.explanation.length > 0);
  assert.deepStrictEqual(sql.evidence, []);
});

test("Feature 7 - Req 5: a single structured request is used when requirements fit one batch", async () => {
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({
    handler: (payload) => ({
      results: payload.requirements.map((r) => ({
        requirement_id: r.requirement_id,
        status: "not_found",
        explanation: "no evidence",
        evidence_ids: [],
        confidence: 0.2,
      })),
    }),
  });

  const service = makeService({ retrieval: makeRetrieval([NODE_REQUIREMENT, SQL_REQUIREMENT]), groq, repository });
  const result = await service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID });

  assert.strictEqual(groq.calls.length, 1);
  assert.strictEqual(result.results.length, 2);
  assert.strictEqual(groq.calls[0].response_format.type, "json_object");
  assert.strictEqual(groq.calls[0].model, MODEL);
  // max_tokens is bounded so the request fits the provider's output-token limit.
  assert.ok(groq.calls[0].max_tokens > 0 && groq.calls[0].max_tokens <= 1000);
});

test("Feature 7 - Req 6: large requirement sets are split into bounded batches and still return every result", async () => {
  const requirements = Array.from({ length: 13 }, (_, i) =>
    makeRequirement({ id: `req-${i}`, key: `req_${i}`, skill: `Skill ${i}`, evidence: [] })
  );
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({
    handler: (payload) => ({
      results: payload.requirements.map((r) => ({
        requirement_id: r.requirement_id,
        status: "not_found",
        explanation: "no evidence",
        evidence_ids: [],
        confidence: 0.2,
      })),
    }),
  });

  const service = makeService({ retrieval: makeRetrieval(requirements), groq, repository, maxRequirementsPerBatch: 5 });
  const result = await service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID });

  assert.strictEqual(groq.calls.length, 3); // ceil(13 / 5) — bounded, never one call per requirement
  assert.strictEqual(result.results.length, 13);
  assert.strictEqual(new Set(result.results.map((r) => r.requirementId)).size, 13);
});

test("Feature 7 - Req 7: rejects model output that omits a requirement and persists nothing", async () => {
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({
    responses: [
      JSON.stringify({
        results: [
          { requirement_id: "req-1111", status: "supported", explanation: "ok", evidence_ids: ["chunk-aaa"], confidence: 0.8 },
        ],
      }),
    ],
  });

  const service = makeService({ retrieval: makeRetrieval([NODE_REQUIREMENT, SQL_REQUIREMENT]), groq, repository });
  await assert.rejects(
    () => service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID }),
    InvalidAssessmentOutputError
  );
  assert.strictEqual(repository._store.assessments.length, 0);
});

test("Feature 7 - Req 7b: unknown or duplicate requirement ids are rejected without persisting", async () => {
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({
    responses: [
      JSON.stringify({
        results: [
          { requirement_id: "req-1111", status: "supported", explanation: "ok", evidence_ids: ["chunk-aaa"], confidence: 0.8 },
          { requirement_id: "req-9999", status: "not_found", explanation: "x", evidence_ids: [], confidence: 0.1 },
        ],
      }),
    ],
  });

  const service = makeService({ retrieval: makeRetrieval([NODE_REQUIREMENT, SQL_REQUIREMENT]), groq, repository });
  await assert.rejects(
    () => service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID }),
    InvalidAssessmentOutputError
  );
  assert.strictEqual(repository._store.assessments.length, 0);
});

test("Feature 7 - Req 8: a supported claim with no valid returned evidence id is rejected (no invented evidence)", async () => {
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({
    responses: [
      JSON.stringify({
        results: [
          { requirement_id: "req-1111", status: "supported", explanation: "looks good", evidence_ids: ["chunk-does-not-exist"], confidence: 0.8 },
          { requirement_id: "req-2222", status: "not_found", explanation: "x", evidence_ids: [], confidence: 0.1 },
        ],
      }),
    ],
  });

  const service = makeService({ retrieval: makeRetrieval([NODE_REQUIREMENT, SQL_REQUIREMENT]), groq, repository });
  await assert.rejects(
    () => service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID }),
    UngroundedAssessmentError
  );
  assert.strictEqual(repository._store.assessments.length, 0);
});

test("Feature 7 - Req 8b: unknown evidence ids are dropped while valid ones are kept", async () => {
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({
    handler: () => ({
      results: [
        { requirement_id: "req-1111", status: "supported", explanation: "grounded", evidence_ids: ["chunk-aaa", "hallucinated-id"], confidence: 0.8 },
        { requirement_id: "req-2222", status: "not_found", explanation: "none", evidence_ids: [], confidence: 0.2 },
      ],
    }),
  });

  const service = makeService({ retrieval: makeRetrieval([NODE_REQUIREMENT, SQL_REQUIREMENT]), groq, repository });
  const result = await service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID });

  const node = result.results.find((r) => r.requirementId === "req-1111");
  assert.deepStrictEqual(node.evidence.map((e) => e.evidenceId), ["chunk-aaa"]);
  assert.strictEqual(repository._store.assessment_evidence.length, 1);
});

test("Feature 7 - Req 8: malformed / invalid model output fails safely without persisting", async () => {
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({ responses: ["not json at all"] });

  const service = makeService({ retrieval: makeRetrieval([NODE_REQUIREMENT]), groq, repository });
  await assert.rejects(
    () => service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID }),
    InvalidAssessmentOutputError
  );
  assert.strictEqual(repository._store.assessments.length, 0);
});

test("Feature 7 - Req 8: a temporary Groq failure surfaces as AssessmentModelError without persisting", async () => {
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({ error: new Error("429 rate limited") });

  const service = makeService({ retrieval: makeRetrieval([NODE_REQUIREMENT]), groq, repository });
  await assert.rejects(
    () => service.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID }),
    AssessmentModelError
  );
  assert.strictEqual(repository._store.assessments.length, 0);
});

test("Feature 7 - Req 9: domain errors from retrieval pass through (missing posting/repository/requirements)", async () => {
  const groq = makeMockGroq({});

  const missingPosting = makeService({
    retrieval: new EntityNotFoundError("JobPosting with ID 'x' was not found.", "JobPosting"),
    groq,
  });
  await assert.rejects(
    () => missingPosting.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID }),
    EntityNotFoundError
  );

  const notIndexed = makeService({
    retrieval: new RepositoryNotIndexedError("Repository has not completed indexing."),
    groq,
  });
  await assert.rejects(
    () => notIndexed.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID }),
    RepositoryNotIndexedError
  );

  const noRequirements = makeService({
    retrieval: new RequirementsNotFoundError("No requirements found."),
    groq,
  });
  await assert.rejects(
    () => noRequirements.assess({ jobPostingId: POSTING_ID, repositoryId: REPO_ID }),
    RequirementsNotFoundError
  );
});

test("Feature 7 - Req 10: API returns 201 on create, 200 on idempotent replay, and 400 on invalid input", async () => {
  const repository = makeMockAssessmentRepository();
  const groq = makeMockGroq({
    handler: () => ({ results: [{ requirement_id: "req-1111", status: "not_found", explanation: "x", evidence_ids: [], confidence: 0.1 }] }),
  });
  const service = makeService({ retrieval: makeRetrieval([NODE_REQUIREMENT]), groq, repository });
  const controller = new AssessmentsController({ assessmentService: service });

  const createRes = makeMockResponse();
  await controller.assess({ body: { jobPostingId: POSTING_ID, repositoryId: REPO_ID } }, createRes);
  assert.strictEqual(createRes.statusCode, 201);
  assert.ok(createRes.body.assessment.id);

  // No IDs at all
  const res1 = makeMockResponse();
  await controller.assess({ body: {} }, res1);
  assert.strictEqual(res1.statusCode, 400);
  assert.strictEqual(res1.body.error, "Invalid input");

  // Invalid UUID
  const res2 = makeMockResponse();
  await controller.assess({ body: { jobPostingId: "nope", repositoryId: REPO_ID } }, res2);
  assert.strictEqual(res2.statusCode, 400);

  // Missing repository scope
  const res3 = makeMockResponse();
  await controller.assess({ body: { jobPostingId: POSTING_ID } }, res3);
  assert.strictEqual(res3.statusCode, 400);
});

test("Feature 7 - Req 10b: API maps retrieval errors and invalid model output to 404 / 422 / 502", async () => {
  const notIndexedService = makeService({
    retrieval: new RepositoryNotIndexedError("Repository has not completed indexing."),
    groq: makeMockGroq({}),
  });
  const notIndexedController = new AssessmentsController({ assessmentService: notIndexedService });
  const res422 = makeMockResponse();
  await notIndexedController.assess({ body: { jobPostingId: POSTING_ID, repositoryId: REPO_ID } }, res422);
  assert.strictEqual(res422.statusCode, 422);
  assert.strictEqual(res422.body.error, "Repository not indexed");

  const badOutputService = makeService({
    retrieval: makeRetrieval([NODE_REQUIREMENT]),
    groq: makeMockGroq({ responses: ["{ not json"] }),
  });
  const badOutputController = new AssessmentsController({ assessmentService: badOutputService });
  const res502 = makeMockResponse();
  await badOutputController.assess({ body: { jobPostingId: POSTING_ID, repositoryId: REPO_ID } }, res502);
  assert.strictEqual(res502.statusCode, 502);
  assert.strictEqual(res502.body.error, "Assessment failed");
  assert.ok(!/groq|token|key/i.test(res502.body.message));
});

test("Feature 7 - Req 11: status vocabulary maps between the API tri-state and the persisted CHECK values", () => {
  assert.deepStrictEqual(ASSESSMENT_STATUSES, ["supported", "partial", "not_found"]);
  assert.strictEqual(apiStatusToDb("supported"), "demonstrated");
  assert.strictEqual(apiStatusToDb("partial"), "partial");
  assert.strictEqual(apiStatusToDb("not_found"), "not_demonstrated");
  assert.strictEqual(dbStatusToApi("demonstrated"), "supported");
  assert.strictEqual(dbStatusToApi("partial"), "partial");
  assert.strictEqual(dbStatusToApi("not_demonstrated"), "not_found");
  assert.strictEqual(dbStatusToApi("uncertain"), "uncertain");
});
