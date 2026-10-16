import { test } from "node:test";
import assert from "node:assert/strict";
import { JobPostingsController } from "./controllers/jobPostingsController.js";
import { RequirementExtractionService } from "./services/requirementExtractionService.js";
import { JobPostingsRepository } from "./repositories/jobPostingsRepository.js";

// ---------------------------------------------------------------------------
// Mock Supabase client
// ---------------------------------------------------------------------------

function makeSupabaseMock({ postingResult, requirementsResult, shouldFail = false } = {}) {
  const insertCalls = [];
  const selectCalls = [];

  const base = {
    from: (table) => {
      return {
        insert: (rows) => {
          insertCalls.push({ table, rows });
          return {
            select: (cols) => {
              selectCalls.push({ table, cols });
              if (shouldFail) {
                return {
                  single: () => ({ data: null, error: new Error("supabase insert failed") }),
                };
              }
              if (table === "job_postings") {
                return {
                  single: () => ({
                    data: postingResult || {
                      id: "posting-123",
                      source_url: "https://example.com/job",
                      raw_text: "We need a developer",
                      fetched_at: "2026-01-01T00:00:00Z",
                      created_at: "2026-01-01T00:00:00Z",
                    },
                    error: null,
                  }),
                };
              }
              if (table === "requirements") {
                return {
                  data: requirementsResult || [
                    {
                      id: "req-1",
                      job_posting_id: "posting-123",
                      requirement_key: "req_1",
                      skill: "Python",
                      description: "Build backend services",
                      evidence_hints: ["src/main.py"],
                      source_excerpt: "Python experience required",
                      sort_order: 0,
                      created_at: "2026-01-01T00:00:00Z",
                    },
                  ],
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          };
        },
        select: () => {
          return {
            eq: () => {
              return {
                order: () => ({ data: [], error: null }),
              };
            },
          };
        },
      };
    },
  };

  return { supabase: base, insertCalls, selectCalls };
}

// ---------------------------------------------------------------------------
// Mock Groq client
// ---------------------------------------------------------------------------

function makeGroqMock({ extractionResult, shouldFail = false, rawContent = null } = {}) {
  const createCalls = [];
  return {
    chat: {
      completions: {
        create: async (opts) => {
          createCalls.push(opts);
          if (shouldFail) {
            throw new Error("groq api error: invalid api key");
          }
          if (rawContent !== null) {
            return { choices: [{ message: { content: rawContent } }] };
          }
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify(extractionResult || {
                    requirements: [
                      {
                        requirement_key: "req_1",
                        skill: "Python",
                        description: "Build backend services",
                        evidence_hints: ["src/main.py", "tests/"],
                        source_excerpt: "Python experience required",
                      },
                    ],
                  }),
                },
              },
            ],
          };
        },
      },
    },
    createCalls,
  };
}

// ---------------------------------------------------------------------------
// Test: valid input extracts and persists
// ---------------------------------------------------------------------------

await test("POST /api/job-postings valid input extracts and persists posting + requirements", async () => {
  const { supabase } = makeSupabaseMock();
  const groq = makeGroqMock();
  const service = new RequirementExtractionService({ groqClient: groq, model: "llama-3.1-8b-instant" });
  const repository = new JobPostingsRepository({ supabaseClient: supabase });
  const controller = new JobPostingsController({ extractionService: service, repository });

  const req = { body: { sourceUrl: "https://example.com/jobs/backend-intern", postingText: "We are hiring a Python developer with React experience." } };
  let resBody;
  const res = {
    status: (code) => {
      assert.strictEqual(code, 201);
      return { json: (body) => { resBody = body; } };
    },
    json: (body) => { resBody = body; },
  };

  await controller.createJobPosting(req, res);

  assert.ok(resBody.posting, "posting should be returned");
  assert.ok(resBody.requirements, "requirements should be returned");
  assert.strictEqual(resBody.requirements.length, 1);
  assert.strictEqual(resBody.requirements[0].skill, "Python");
  assert.strictEqual(resBody.requirements[0].source_excerpt, "Python experience required");

  // Verify Groq was called with model
  assert.ok(groq.createCalls.length > 0, "Groq should be called");
  assert.strictEqual(groq.createCalls[0].model, "llama-3.1-8b-instant");
});

// ---------------------------------------------------------------------------
// Test: invalid URL rejected before Groq
// ---------------------------------------------------------------------------

await test("invalid sourceUrl is rejected before calling Groq", async () => {
  const { supabase } = makeSupabaseMock();
  const groq = makeGroqMock();
  const service = new RequirementExtractionService({ groqClient: groq, model: "llama-3.1-8b-instant" });
  const repository = new JobPostingsRepository({ supabaseClient: supabase });
  const controller = new JobPostingsController({ extractionService: service, repository });

  const req = { body: { sourceUrl: "ftp://example.com/job", postingText: "Some posting text" } };
  let resBody;
  const res = {
    status: (code) => {
      assert.strictEqual(code, 400);
      return { json: (body) => { resBody = body; } };
    },
    json: (body) => { resBody = body; },
  };

  await controller.createJobPosting(req, res);

  assert.strictEqual(resBody.error, "Invalid input");
  assert.ok(groq.createCalls.length === 0, "Groq should NOT be called for invalid input");
});

// ---------------------------------------------------------------------------
// Test: empty posting text rejected before Groq
// ---------------------------------------------------------------------------

await test("empty postingText is rejected before calling Groq", async () => {
  const { supabase } = makeSupabaseMock();
  const groq = makeGroqMock();
  const service = new RequirementExtractionService({ groqClient: groq, model: "llama-3.1-8b-instant" });
  const repository = new JobPostingsRepository({ supabaseClient: supabase });
  const controller = new JobPostingsController({ extractionService: service, repository });

  const req = { body: { sourceUrl: "https://example.com/job", postingText: "" } };
  let resBody;
  const res = {
    status: (code) => {
      assert.strictEqual(code, 400);
      return { json: (body) => { resBody = body; } };
    },
    json: (body) => { resBody = body; },
  };

  await controller.createJobPosting(req, res);

  assert.strictEqual(resBody.error, "Invalid input");
  assert.ok(groq.createCalls.length === 0, "Groq should NOT be called for empty text");
});

// ---------------------------------------------------------------------------
// Test: malformed Groq output rejected and not persisted
// ---------------------------------------------------------------------------

await test("malformed Groq output is rejected and not persisted", async () => {
  const { supabase, insertCalls } = makeSupabaseMock();
  const groq = makeGroqMock({ rawContent: "not json at all" });
  const service = new RequirementExtractionService({ groqClient: groq, model: "llama-3.1-8b-instant" });
  const repository = new JobPostingsRepository({ supabaseClient: supabase });
  const controller = new JobPostingsController({ extractionService: service, repository });

  const req = { body: { sourceUrl: "https://example.com/job", postingText: "We need a developer" } };
  let resBody;
  const res = {
    status: (code) => {
      assert.strictEqual(code, 502);
      return { json: (body) => { resBody = body; } };
    },
    json: (body) => { resBody = body; },
  };

  await controller.createJobPosting(req, res);

  assert.ok(resBody.error, "should return error");
  assert.ok(!resBody.message.includes("groq api"), "should not leak provider internals");
  assert.strictEqual(insertCalls.length, 0, "nothing should be persisted");
});

// ---------------------------------------------------------------------------
// Test: Groq output missing required fields fails validation
// ---------------------------------------------------------------------------

await test("Groq output missing required fields is rejected", async () => {
  const { supabase, insertCalls } = makeSupabaseMock();
  const groq = makeGroqMock({ rawContent: JSON.stringify({ requirements: [{ skill: "Python" }] }) });
  const service = new RequirementExtractionService({ groqClient: groq, model: "llama-3.1-8b-instant" });
  const repository = new JobPostingsRepository({ supabaseClient: supabase });
  const controller = new JobPostingsController({ extractionService: service, repository });

  const req = { body: { sourceUrl: "https://example.com/job", postingText: "We need a developer" } };
  let resBody;
  const res = {
    status: (code) => {
      assert.strictEqual(code, 502);
      return { json: (body) => { resBody = body; } };
    },
    json: (body) => { resBody = body; },
  };

  await controller.createJobPosting(req, res);

  assert.strictEqual(resBody.error, "Requirement extraction failed");
  assert.strictEqual(insertCalls.length, 0, "nothing should be persisted");
});

// ---------------------------------------------------------------------------
// Test: Groq error returns safe error without leaking secrets
// ---------------------------------------------------------------------------

await test("Groq error returns safe error without leaking internals", async () => {
  const { supabase, insertCalls } = makeSupabaseMock();
  const groq = makeGroqMock({ shouldFail: true });
  const service = new RequirementExtractionService({ groqClient: groq, model: "llama-3.1-8b-instant" });
  const repository = new JobPostingsRepository({ supabaseClient: supabase });
  const controller = new JobPostingsController({ extractionService: service, repository });

  const req = { body: { sourceUrl: "https://example.com/job", postingText: "We need a developer" } };
  let resBody;
  const res = {
    status: (code) => {
      assert.strictEqual(code, 502);
      return { json: (body) => { resBody = body; } };
    },
    json: (body) => { resBody = body; },
  };

  await controller.createJobPosting(req, res);

  assert.strictEqual(resBody.error, "Requirement extraction failed");
  assert.ok(!resBody.message.includes("api key"), "should not leak API key");
  assert.ok(!resBody.message.includes("groq api error"), "should not leak provider internals");
  assert.strictEqual(insertCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Test: Supabase error returns safe error
// ---------------------------------------------------------------------------

await test("Supabase error returns safe error without leaking internals", async () => {
  const { supabase } = makeSupabaseMock({ shouldFail: true });
  const groq = makeGroqMock();
  const service = new RequirementExtractionService({ groqClient: groq, model: "llama-3.1-8b-instant" });
  const repository = new JobPostingsRepository({ supabaseClient: supabase });
  const controller = new JobPostingsController({ extractionService: service, repository });

  const req = { body: { sourceUrl: "https://example.com/job", postingText: "We need a developer" } };
  let resBody;
  const res = {
    status: (code) => {
      assert.strictEqual(code, 500);
      return { json: (body) => { resBody = body; } };
    },
    json: (body) => { resBody = body; },
  };

  await controller.createJobPosting(req, res);

  assert.strictEqual(resBody.error, "Database error");
  assert.ok(!resBody.message.includes("supabase"), "should not leak provider internals");
});

// ---------------------------------------------------------------------------
// Test: empty extraction results handled safely
// ---------------------------------------------------------------------------

await test("empty extraction results are handled safely", async () => {
  const { supabase, insertCalls } = makeSupabaseMock();
  const groq = makeGroqMock({ rawContent: JSON.stringify({ requirements: [] }) });
  const service = new RequirementExtractionService({ groqClient: groq, model: "llama-3.1-8b-instant" });
  const repository = new JobPostingsRepository({ supabaseClient: supabase });
  const controller = new JobPostingsController({ extractionService: service, repository });

  const req = { body: { sourceUrl: "https://example.com/job", postingText: "We need a developer" } };
  let resBody;
  const res = {
    status: (code) => {
      assert.strictEqual(code, 502);
      return { json: (body) => { resBody = body; } };
    },
    json: (body) => { resBody = body; },
  };

  await controller.createJobPosting(req, res);

  assert.ok(resBody.error, "should return error for empty extraction");
  assert.strictEqual(insertCalls.length, 0, "nothing should be persisted");
});

// ---------------------------------------------------------------------------
// Test: requirements linked to correct posting with source excerpts
// ---------------------------------------------------------------------------

await test("saved requirements retain source excerpts and link to posting", async () => {
  const { supabase } = makeSupabaseMock({
    postingResult: {
      id: "posting-abc",
      source_url: "https://example.com/jobs/backend-intern",
      raw_text: "We need Python and React",
      fetched_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
    },
    requirementsResult: [
      {
        id: "req-1",
        job_posting_id: "posting-abc",
        requirement_key: "req_1",
        skill: "Python",
        description: "Build backend services",
        evidence_hints: ["src/main.py"],
        source_excerpt: "Python experience required",
        sort_order: 0,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "req-2",
        job_posting_id: "posting-abc",
        requirement_key: "req_2",
        skill: "React",
        description: "Build UIs",
        evidence_hints: ["src/App.jsx"],
        source_excerpt: "React experience required",
        sort_order: 1,
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  });

  const groq = makeGroqMock({
    rawContent: JSON.stringify({
      requirements: [
        {
          requirement_key: "req_1",
          skill: "Python",
          description: "Build backend services",
          evidence_hints: ["src/main.py"],
          source_excerpt: "Python experience required",
        },
        {
          requirement_key: "req_2",
          skill: "React",
          description: "Build UIs",
          evidence_hints: ["src/App.jsx"],
          source_excerpt: "React experience required",
        },
      ],
    }),
  });
  const service = new RequirementExtractionService({ groqClient: groq, model: "llama-3.1-8b-instant" });
  const repository = new JobPostingsRepository({ supabaseClient: supabase });
  const controller = new JobPostingsController({ extractionService: service, repository });

  const req = {
    body: {
      sourceUrl: "https://example.com/jobs/backend-intern",
      postingText: "We need Python and React",
    },
  };
  let resBody;
  const res = {
    status: () => ({ json: (body) => { resBody = body; } }),
    json: (body) => { resBody = body; },
  };

  await controller.createJobPosting(req, res);

  assert.ok(resBody, "response body should be set");
  assert.ok(resBody.posting, "posting should be returned");
  assert.ok(resBody.requirements, "requirements should be returned");
  assert.strictEqual(resBody.requirements.length, 2);
  assert.strictEqual(resBody.requirements[0].source_excerpt, "Python experience required");
  assert.strictEqual(resBody.requirements[1].source_excerpt, "React experience required");
  assert.strictEqual(resBody.requirements[0].job_posting_id, "posting-abc");
  assert.strictEqual(resBody.requirements[1].job_posting_id, "posting-abc");
  assert.ok(resBody.requirements.every((r) => r.source_excerpt && r.source_excerpt.length > 0), "all have source excerpts");
});
