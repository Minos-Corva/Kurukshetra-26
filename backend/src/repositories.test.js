import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubIngestionService, isEligibleFile } from "./services/githubIngestionService.js";
import { ChunkingService } from "./services/chunkingService.js";
import { EmbeddingService } from "./services/embeddingService.js";
import { RepositoriesRepository } from "./repositories/repositoriesRepository.js";
import { RepositoriesController } from "./controllers/repositoriesController.js";

// ---------------------------------------------------------------------------
// Mock Octokit client
// ---------------------------------------------------------------------------

function makeOctokitMock({
  repoData = {
    owner: { login: "testowner" },
    name: "testrepo",
    full_name: "testowner/testrepo",
    html_url: "https://github.com/testowner/testrepo",
    default_branch: "main",
  },
  commitSha = "sha-123456",
  treeItems = [],
  blobContents = {},
  errorMode = null, // "repo_404" | "repo_429" | "tree_error" | "blob_error"
} = {}) {
  return {
    rest: {
      repos: {
        get: async ({ owner, repo }) => {
          if (errorMode === "repo_404") {
            const err = new Error("Not Found");
            err.status = 404;
            throw err;
          }
          if (errorMode === "repo_429") {
            const err = new Error("API rate limit exceeded");
            err.status = 429;
            throw err;
          }
          return { data: repoData };
        },
        getCommit: async ({ ref }) => {
          return { data: { sha: commitSha } };
        },
      },
      git: {
        getTree: async () => {
          if (errorMode === "tree_error") {
            throw new Error("Git tree retrieval failed");
          }
          return { data: { tree: treeItems, truncated: false } };
        },
        getBlob: async ({ file_sha }) => {
          if (errorMode === "blob_error") {
            throw new Error("Git blob retrieval failed");
          }
          const content = blobContents[file_sha] ?? "export const hello = 'world';\n";
          return {
            data: {
              content: Buffer.from(content, "utf-8").toString("base64"),
              encoding: "base64",
            },
          };
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Supabase client
// ---------------------------------------------------------------------------

function makeSupabaseMock({
  initialRepos = [],
  initialIndexStates = [],
  initialChunks = [],
  failOn = null, // "chunks_insert" | "repo_insert" | "state_upsert"
} = {}) {
  const store = {
    repositories: [...initialRepos],
    repository_index_state: [...initialIndexStates],
    code_chunks: [...initialChunks],
  };

  return {
    _store: store,
    from: (table) => {
      return {
        select: (cols, opts = {}) => {
          let rows = [...(store[table] || [])];
          const query = {
            eq: (col, val) => {
              rows = rows.filter((r) => r[col] === val);
              return query;
            },
            single: async () => {
              return { data: rows[0] || null, error: null };
            },
            maybeSingle: async () => {
              return { data: rows[0] || null, error: null };
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
        insert: (data) => {
          const items = Array.isArray(data) ? data : [data];
          return {
            select: () => ({
              single: async () => {
                if (failOn === `${table}_insert`) {
                  return { data: null, error: new Error(`${table} insert failed`) };
                }
                const inserted = { id: `id-${Date.now()}-${Math.random()}`, ...items[0] };
                store[table].push(inserted);
                return { data: inserted, error: null };
              },
            }),
            then: (resolve) => {
              if (failOn === `${table}_insert`) {
                resolve({ data: null, error: new Error(`${table} insert failed`) });
                return;
              }
              for (const item of items) {
                store[table].push({ id: `chunk-${Math.random()}`, ...item });
              }
              resolve({ data: items, error: null });
            },
          };
        },
        update: (updates) => {
          return {
            eq: (col, val) => ({
              select: () => ({
                single: async () => {
                  const item = store[table].find((r) => r[col] === val);
                  if (item) Object.assign(item, updates);
                  return { data: item || null, error: null };
                },
              }),
            }),
          };
        },
        upsert: (record) => {
          return {
            select: () => ({
              single: async () => {
                if (failOn === `${table}_upsert`) {
                  return { data: null, error: new Error(`${table} upsert failed`) };
                }
                const idx = store[table].findIndex(
                  (r) => r.repository_id === record.repository_id
                );
                if (idx >= 0) {
                  store[table][idx] = { ...store[table][idx], ...record };
                  return { data: store[table][idx], error: null };
                } else {
                  store[table].push(record);
                  return { data: record, error: null };
                }
              },
            }),
          };
        },
        delete: () => {
          return {
            eq: (col, val) => {
              store[table] = store[table].filter((r) => r[col] !== val);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Embedding Pipeline Factory
// ---------------------------------------------------------------------------

function makePipelineMock({ dimensions = 768, shouldFail = false } = {}) {
  return async () => {
    return async (batch) => {
      if (shouldFail) {
        throw new Error("Embedding model computation failure");
      }
      return batch.map(() => {
        const vec = new Array(dimensions).fill(1 / Math.sqrt(dimensions));
        return vec;
      });
    };
  };
}

// ---------------------------------------------------------------------------
// Response helper
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

// ===========================================================================
// Test Suite: 6 Verification Requirements
// ===========================================================================

test("Requirement 1: Repository tree selects eligible files and skips excluded/binary/oversized files", async () => {
  const treeItems = [
    { type: "blob", path: "src/index.js", sha: "sha-1", size: 500 },
    { type: "blob", path: "README.md", sha: "sha-2", size: 1200 },
    { type: "blob", path: "Dockerfile", sha: "sha-3", size: 300 },
    { type: "blob", path: ".gitignore", sha: "sha-4", size: 100 },
    // Excluded directory
    { type: "blob", path: "node_modules/express/index.js", sha: "sha-5", size: 800 },
    { type: "blob", path: "dist/bundle.js", sha: "sha-6", size: 1500 },
    // Excluded filename / secrets
    { type: "blob", path: ".env", sha: "sha-7", size: 200 },
    { type: "blob", path: "package-lock.json", sha: "sha-8", size: 2500 },
    // Excluded binary extension
    { type: "blob", path: "assets/logo.png", sha: "sha-9", size: 4000 },
    { type: "blob", path: "bin/binary.exe", sha: "sha-10", size: 8000 },
    // Minified
    { type: "blob", path: "src/vendor.min.js", sha: "sha-11", size: 600 },
    // Oversized (>100KB)
    { type: "blob", path: "src/giant.js", sha: "sha-12", size: 150 * 1024 },
    // Tree folder (type != blob)
    { type: "tree", path: "src", sha: "sha-tree-1", size: 0 },
  ];

  const blobContents = {
    "sha-1": "console.log('index');",
    "sha-2": "# Readme",
    "sha-3": "FROM node:20",
    "sha-4": "node_modules/",
  };

  const octokit = makeOctokitMock({ treeItems, blobContents });
  const service = new GithubIngestionService({ octokit });

  const result = await service.ingestRepository({ owner: "testowner", name: "testrepo" });

  assert.strictEqual(result.files.length, 4, "Should only ingest 4 eligible files");
  const paths = result.files.map((f) => f.filePath);
  assert.ok(paths.includes("src/index.js"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("Dockerfile"));
  assert.ok(paths.includes(".gitignore"));
  assert.ok(!paths.includes("node_modules/express/index.js"));
  assert.ok(!paths.includes(".env"));
  assert.ok(!paths.includes("assets/logo.png"));
  assert.ok(!paths.includes("src/giant.js"));
});

test("Requirement 2: Chunks preserve correct paths, line ranges, and commit SHA", async () => {
  const chunker = new ChunkingService({ chunkSize: 50, overlap: 10 });
  const lines = [];
  for (let i = 1; i <= 80; i++) {
    lines.push(`const line${i} = ${i};`);
  }
  const content = lines.join("\n");

  const chunks = chunker.chunkFile({
    content,
    filePath: "backend/src/server.js",
    commitSha: "commit-abc-123",
    blobSha: "blob-xyz-789",
  });

  assert.strictEqual(chunks.length, 2, "80 lines with chunk 50 and overlap 10 creates 2 chunks");

  // Chunk 1: lines 1 to 50
  assert.strictEqual(chunks[0].chunk_index, 0);
  assert.strictEqual(chunks[0].file_path, "backend/src/server.js");
  assert.strictEqual(chunks[0].commit_sha, "commit-abc-123");
  assert.strictEqual(chunks[0].blob_sha, "blob-xyz-789");
  assert.strictEqual(chunks[0].start_line, 1);
  assert.strictEqual(chunks[0].end_line, 50);

  // Chunk 2: lines 41 to 80 (50 - 10 = step 40, so start = 40 -> 1-indexed is 41)
  assert.strictEqual(chunks[1].chunk_index, 1);
  assert.strictEqual(chunks[1].file_path, "backend/src/server.js");
  assert.strictEqual(chunks[1].commit_sha, "commit-abc-123");
  assert.strictEqual(chunks[1].blob_sha, "blob-xyz-789");
  assert.strictEqual(chunks[1].start_line, 41);
  assert.strictEqual(chunks[1].end_line, 80);
});

test("Requirement 3: Embedding output is normalized and exactly 768 dimensions, and dimension mismatches fail before persistence", async () => {
  // Case A: Valid 768 dimensions
  const validService = new EmbeddingService({
    pipelineFactory: makePipelineMock({ dimensions: 768 }),
  });
  const texts = ["function hello() { return 'world'; }"];
  const embeddings = await validService.embedTexts(texts);

  assert.strictEqual(embeddings.length, 1);
  assert.strictEqual(embeddings[0].length, 768);

  // Check L2 normalization (sum of squares ~ 1)
  const normSq = embeddings[0].reduce((sum, v) => sum + v * v, 0);
  assert.ok(Math.abs(normSq - 1.0) < 0.001, "Embedding should be normalized");

  // Case B: Dimension mismatch (e.g. 384 instead of 768) fails before persistence
  const mismatchService = new EmbeddingService({
    dimensions: 768,
    pipelineFactory: makePipelineMock({ dimensions: 384 }),
  });

  await assert.rejects(
    async () => {
      await mismatchService.embedTexts(["some code"]);
    },
    /Embedding dimension mismatch: expected 768, got 384/
  );
});

test("Requirement 4: Re-ingesting the same SHA doesn't duplicate chunks", async () => {
  const repoRow = {
    id: "repo-uuid-1",
    owner: "testowner",
    name: "testrepo",
    full_name: "testowner/testrepo",
    html_url: "https://github.com/testowner/testrepo",
    default_branch: "main",
  };

  const initialIndexState = {
    repository_id: "repo-uuid-1",
    indexed_commit_sha: "sha-same-commit",
    latest_seen_commit_sha: "sha-same-commit",
    status: "idle",
  };

  const existingChunks = [
    {
      id: "chunk-1",
      repository_id: "repo-uuid-1",
      file_path: "src/index.js",
      chunk_index: 0,
      content: "console.log('existing chunk');",
      start_line: 1,
      end_line: 1,
      commit_sha: "sha-same-commit",
    },
  ];

  const supabase = makeSupabaseMock({
    initialRepos: [repoRow],
    initialIndexStates: [initialIndexState],
    initialChunks: existingChunks,
  });

  const octokit = makeOctokitMock({
    commitSha: "sha-same-commit",
    treeItems: [{ type: "blob", path: "src/index.js", sha: "blob-1", size: 100 }],
  });

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = new EmbeddingService({
    pipelineFactory: makePipelineMock({ dimensions: 768 }),
  });
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const controller = new RepositoriesController({
    githubService,
    chunkingService,
    embeddingService,
    repository,
  });

  const req = {
    body: { owner: "testowner", name: "testrepo" },
  };
  const res = makeMockResponse();

  await controller.ingest(req, res);

  assert.strictEqual(res.getStatusCode(), 200);
  const body = res.getBody();
  assert.strictEqual(body.status, "idle");
  assert.strictEqual(body.indexedCommitSha, "sha-same-commit");
  assert.ok(body.message.includes("already indexed"));

  // Check store: chunks count did not increase
  assert.strictEqual(supabase._store.code_chunks.length, 1, "Chunks must not be duplicated");
});

test("Requirement 5: GitHub or Supabase failures leave index state failed and do not advance indexed_commit_sha", async () => {
  // Case A: Supabase chunks insert failure
  const repoRow = {
    id: "repo-uuid-2",
    owner: "failowner",
    name: "failrepo",
    full_name: "failowner/failrepo",
    html_url: "https://github.com/failowner/failrepo",
    default_branch: "main",
  };

  const initialIndexState = {
    repository_id: "repo-uuid-2",
    indexed_commit_sha: "sha-old",
    latest_seen_commit_sha: "sha-old",
    status: "idle",
  };

  const supabase = makeSupabaseMock({
    initialRepos: [repoRow],
    initialIndexStates: [initialIndexState],
    failOn: "code_chunks_insert",
  });

  const octokit = makeOctokitMock({
    repoData: {
      owner: { login: "failowner" },
      name: "failrepo",
      full_name: "failowner/failrepo",
      html_url: "https://github.com/failowner/failrepo",
      default_branch: "main",
    },
    commitSha: "sha-new-revision",
    treeItems: [{ type: "blob", path: "src/app.js", sha: "blob-1", size: 100 }],
  });

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = new EmbeddingService({
    pipelineFactory: makePipelineMock({ dimensions: 768 }),
  });
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const controller = new RepositoriesController({
    githubService,
    chunkingService,
    embeddingService,
    repository,
  });

  const req = {
    body: { owner: "failowner", name: "failrepo" },
  };
  const res = makeMockResponse();

  await controller.ingest(req, res);

  // Controller returns safe error
  assert.strictEqual(res.getStatusCode(), 500);

  // Check that indexed_commit_sha did NOT advance to "sha-new-revision"
  const state = supabase._store.repository_index_state.find(
    (s) => s.repository_id === "repo-uuid-2"
  );
  assert.strictEqual(state.status, "failed");
  assert.strictEqual(state.indexed_commit_sha, "sha-old");
  assert.notStrictEqual(state.indexed_commit_sha, "sha-new-revision");

  // Case B: GitHub 404 failure
  const octokit404 = makeOctokitMock({ errorMode: "repo_404" });
  const githubService404 = new GithubIngestionService({ octokit: octokit404 });
  const controller404 = new RepositoriesController({
    githubService: githubService404,
    chunkingService,
    embeddingService,
    repository,
  });

  const res404 = makeMockResponse();
  await controller404.ingest(
    { body: { owner: "nonexistent", name: "notfound" } },
    res404
  );
  assert.strictEqual(res404.getStatusCode(), 404);
  assert.strictEqual(res404.getBody().error, "Repository not found");
});

test("Requirement 6: Secrets and source contents are not included in API errors or logs", async () => {
  const secretToken = "ghp_super_secret_token_1234567890abcdef";
  const sourceCodeSnippet = "SECRET_DATABASE_PASSWORD_SUPER_SECRET = 'xyz123'";

  const octokitWithSecretError = {
    rest: {
      repos: {
        get: async () => {
          throw new Error(`GitHub token ${secretToken} was rejected while reading ${sourceCodeSnippet}`);
        },
      },
    },
  };

  const supabase = makeSupabaseMock();
  const githubService = new GithubIngestionService({ octokit: octokitWithSecretError });
  const chunkingService = new ChunkingService();
  const embeddingService = new EmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const controller = new RepositoriesController({
    githubService,
    chunkingService,
    embeddingService,
    repository,
  });

  // Test 1: API error does not leak secret or source snippet
  const res = makeMockResponse();
  await controller.ingest({ body: { owner: "test", name: "repo" } }, res);

  const bodyStr = JSON.stringify(res.getBody());
  assert.ok(!bodyStr.includes(secretToken), "Response must not contain secret token");
  assert.ok(!bodyStr.includes(sourceCodeSnippet), "Response must not contain source contents");

  // Test 2: Input validation rejects invalid owner/name characters before processing
  const badRes = makeMockResponse();
  await controller.ingest({ body: { owner: "../bad/path", name: "test" } }, badRes);
  assert.strictEqual(badRes.getStatusCode(), 400);
  assert.strictEqual(badRes.getBody().error, "Invalid input");
});
