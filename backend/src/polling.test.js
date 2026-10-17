import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubIngestionService } from "./services/githubIngestionService.js";
import { ChunkingService } from "./services/chunkingService.js";
import { EmbeddingService } from "./services/embeddingService.js";
import { RepositoriesRepository } from "./repositories/repositoriesRepository.js";
import { PollingService } from "./services/pollingService.js";

// ---------------------------------------------------------------------------
// Helpers: Mock Supabase Client for Polling Tests
// ---------------------------------------------------------------------------

function makeSupabaseMock({
  initialRepos = [],
  initialIndexStates = [],
  initialChunks = [],
  failOn = null, // "chunks_insert" | "chunks_delete" | "state_upsert"
} = {}) {
  const store = {
    repositories: JSON.parse(JSON.stringify(initialRepos)),
    repository_index_state: JSON.parse(JSON.stringify(initialIndexStates)),
    code_chunks: JSON.parse(JSON.stringify(initialChunks)),
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
            in: (col, vals) => {
              rows = rows.filter((r) => vals.includes(r[col]));
              return query;
            },
            order: (_col, _opts) => query,
            single: async () => {
              return { data: rows[0] || null, error: null };
            },
            maybeSingle: async () => {
              return { data: rows[0] || null, error: null };
            },
            then: (resolve) => {
              if (opts.count === "exact" && opts.head) {
                resolve({ count: rows.length, data: null, error: null });
              } else {
                resolve({ data: rows, error: null });
              }
            },
          };
          return query;
        },

        insert: async (data) => {
          if (failOn === "chunks_insert" && table === "code_chunks") {
            return { data: null, error: new Error("Supabase insert error: simulated code_chunks failure") };
          }
          const items = Array.isArray(data) ? data : [data];
          const inserted = items.map((item, idx) => ({
            id: item.id || `chunk-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
            ...item,
          }));
          store[table].push(...inserted);
          return {
            data: Array.isArray(data) ? inserted : inserted[0],
            error: null,
            select: () => ({
              single: async () => ({ data: inserted[0], error: null }),
            }),
          };
        },

        delete: (opts = {}) => {
          if (failOn === "chunks_delete" && table === "code_chunks") {
            return {
              eq: () => ({
                in: async () => ({ data: null, error: new Error("Simulated delete failure"), count: 0 }),
              }),
            };
          }
          let toDelete = [...(store[table] || [])];
          const delQuery = {
            eq: (col, val) => {
              toDelete = toDelete.filter((r) => r[col] === val);
              return delQuery;
            },
            in: async (col, vals) => {
              const matched = toDelete.filter((r) => vals.includes(r[col]));
              store[table] = store[table].filter((r) => !matched.includes(r));
              return {
                data: matched,
                count: matched.length,
                error: null,
              };
            },
            then: async (resolve) => {
              store[table] = store[table].filter((r) => !toDelete.includes(r));
              resolve({ data: toDelete, count: toDelete.length, error: null });
            },
          };
          return delQuery;
        },

        upsert: (data) => {
          if (failOn === "state_upsert" && table === "repository_index_state") {
            return {
              select: () => ({
                single: async () => ({ data: null, error: new Error("Simulated state upsert error") }),
              }),
            };
          }
          const key = table === "repository_index_state" ? "repository_id" : "id";
          const matchVal = data[key];
          const existingIdx = store[table].findIndex((r) => r[key] === matchVal);
          let row;
          if (existingIdx >= 0) {
            row = { ...store[table][existingIdx], ...data };
            store[table][existingIdx] = row;
          } else {
            row = { ...data };
            store[table].push(row);
          }
          return {
            select: () => ({
              single: async () => ({ data: row, error: null }),
            }),
          };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers: Mock Octokit Client for Polling Tests
// ---------------------------------------------------------------------------

function makeOctokitMock({
  commitSha = "sha-latest",
  comparisonFiles = [],
  blobMap = {},
  errorMode = null,
} = {}) {
  return {
    rest: {
      repos: {
        get: async () => ({
          data: {
            owner: { login: "testowner" },
            name: "testrepo",
            full_name: "testowner/testrepo",
            default_branch: "main",
          },
        }),
        getCommit: async () => {
          if (errorMode === "get_commit_error") {
            const err = new Error("GitHub commit retrieval failed");
            err.status = 500;
            throw err;
          }
          return { data: { sha: commitSha } };
        },
        compareCommits: async ({ base, head }) => {
          if (errorMode === "compare_error") {
            const err = new Error("GitHub comparison failed");
            err.status = 500;
            throw err;
          }
          if (errorMode === "compare_404") {
            const err = new Error("GitHub resource not found: commit comparison");
            err.status = 404;
            throw err;
          }
          return {
            data: {
              status: "ahead",
              ahead_by: 1,
              behind_by: 0,
              total_commits: 1,
              files: comparisonFiles,
            },
          };
        },
      },
      git: {
        getBlob: async ({ file_sha }) => {
          if (errorMode === "blob_error") {
            const err = new Error("GitHub blob retrieval failed");
            err.status = 500;
            throw err;
          }
          const item = blobMap[file_sha] || {
            content: "function test() { return 42; }\n",
            size: 32,
          };
          return {
            data: {
              content: Buffer.from(item.content, "utf-8").toString("base64"),
              encoding: "base64",
              size: item.size || Buffer.byteLength(item.content, "utf-8"),
            },
          };
        },
        getTree: async () => ({
          data: {
            tree: [
              { path: "src/index.js", type: "blob", sha: "sha-index-blob", size: 100 },
            ],
            truncated: false,
          },
        }),
      },
    },
  };
}

function makeMockEmbeddingService() {
  return new EmbeddingService({
    pipelineFactory: () => {
      return async (texts) => {
        return texts.map(() => {
          const v = new Array(768).fill(0);
          v[0] = 1.0;
          return v;
        });
      };
    },
  });
}

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Feature 9 - Req 1: skips unchanged repository when commit SHA matches indexed SHA without re-chunking or re-embedding", async () => {
  const repoId = "repo-uuid-1";
  const supabase = makeSupabaseMock({
    initialRepos: [{ id: repoId, owner: "testowner", name: "testrepo", default_branch: "main" }],
    initialIndexStates: [
      { repository_id: repoId, indexed_commit_sha: "sha-100", status: "idle" },
    ],
    initialChunks: [
      { id: "c1", repository_id: repoId, file_path: "src/index.js", chunk_index: 0, content: "code" },
    ],
  });

  const octokit = makeOctokitMock({ commitSha: "sha-100" });
  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  let embedCalled = false;
  embeddingService.embedChunks = async () => {
    embedCalled = true;
    return [];
  };

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: silentLogger,
  });

  const res = await poller.pollRepository({ repositoryId: repoId });

  assert.equal(res.status, "unchanged");
  assert.equal(res.commitSha, "sha-100");
  assert.equal(embedCalled, false, "Should not embed chunks when commit has not changed");
  assert.equal(supabase._store.code_chunks.length, 1, "Existing chunks must remain intact");
});

test("Feature 9 - Req 2: incremental update adds new chunks for added files and replaces modified files", async () => {
  const repoId = "repo-uuid-2";
  const supabase = makeSupabaseMock({
    initialRepos: [{ id: repoId, owner: "testowner", name: "testrepo", default_branch: "main" }],
    initialIndexStates: [
      { repository_id: repoId, indexed_commit_sha: "sha-100", status: "idle" },
    ],
    initialChunks: [
      {
        id: "c-old-index",
        repository_id: repoId,
        file_path: "src/index.js",
        chunk_index: 0,
        content: "old index code",
        commit_sha: "sha-100",
      },
      {
        id: "c-readme",
        repository_id: repoId,
        file_path: "README.md",
        chunk_index: 0,
        content: "documentation",
        commit_sha: "sha-100",
      },
    ],
  });

  const octokit = makeOctokitMock({
    commitSha: "sha-200",
    comparisonFiles: [
      {
        filename: "src/index.js",
        status: "modified",
        sha: "blob-index-new",
      },
      {
        filename: "src/utils.js",
        status: "added",
        sha: "blob-utils-new",
      },
    ],
    blobMap: {
      "blob-index-new": { content: "new index code line 1\nline 2\n", size: 30 },
      "blob-utils-new": { content: "export function util() { return true; }\n", size: 40 },
    },
  });

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: silentLogger,
  });

  const res = await poller.pollRepository({ repositoryId: repoId });

  assert.equal(res.status, "updated");
  assert.equal(res.oldCommitSha, "sha-100");
  assert.equal(res.newCommitSha, "sha-200");
  assert.equal(res.stats.added, 1);
  assert.equal(res.stats.modified, 1);

  // Check chunks in store
  const chunks = supabase._store.code_chunks;
  const indexChunks = chunks.filter((c) => c.file_path === "src/index.js");
  const utilsChunks = chunks.filter((c) => c.file_path === "src/utils.js");
  const readmeChunks = chunks.filter((c) => c.file_path === "README.md");

  // Old index chunk was replaced with new chunk
  assert.equal(indexChunks.length, 1);
  assert.match(indexChunks[0].content, /new index code/);
  assert.equal(indexChunks[0].commit_sha, "sha-200");

  // New utils chunk was inserted
  assert.equal(utilsChunks.length, 1);
  assert.match(utilsChunks[0].content, /export function util/);
  assert.equal(utilsChunks[0].commit_sha, "sha-200");

  // README chunk was untouched!
  assert.equal(readmeChunks.length, 1);
  assert.equal(readmeChunks[0].id, "c-readme");
  assert.equal(readmeChunks[0].commit_sha, "sha-100");

  // Index state updated to idle at sha-200
  const state = supabase._store.repository_index_state.find((s) => s.repository_id === repoId);
  assert.equal(state.indexed_commit_sha, "sha-200");
  assert.equal(state.status, "idle");
  assert.equal(state.last_error, null);
});

test("Feature 9 - Req 3: removes all chunks belonging to deleted files", async () => {
  const repoId = "repo-uuid-3";
  const supabase = makeSupabaseMock({
    initialRepos: [{ id: repoId, owner: "testowner", name: "testrepo", default_branch: "main" }],
    initialIndexStates: [
      { repository_id: repoId, indexed_commit_sha: "sha-100", status: "idle" },
    ],
    initialChunks: [
      { id: "c-deleted", repository_id: repoId, file_path: "src/oldFile.js", chunk_index: 0, content: "old" },
      { id: "c-kept", repository_id: repoId, file_path: "src/keptFile.js", chunk_index: 0, content: "keep me" },
    ],
  });

  const octokit = makeOctokitMock({
    commitSha: "sha-200",
    comparisonFiles: [
      { filename: "src/oldFile.js", status: "removed" },
    ],
  });

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: silentLogger,
  });

  const res = await poller.pollRepository({ repositoryId: repoId });

  assert.equal(res.status, "updated");
  assert.equal(res.stats.deleted, 1);

  // Deleted file chunk is gone
  const deletedChunks = supabase._store.code_chunks.filter((c) => c.file_path === "src/oldFile.js");
  assert.equal(deletedChunks.length, 0);

  // Kept file chunk remains
  const keptChunks = supabase._store.code_chunks.filter((c) => c.file_path === "src/keptFile.js");
  assert.equal(keptChunks.length, 1);
});

test("Feature 9 - Req 4: handles renamed files by removing old path chunks and indexing new path", async () => {
  const repoId = "repo-uuid-4";
  const supabase = makeSupabaseMock({
    initialRepos: [{ id: repoId, owner: "testowner", name: "testrepo", default_branch: "main" }],
    initialIndexStates: [
      { repository_id: repoId, indexed_commit_sha: "sha-100", status: "idle" },
    ],
    initialChunks: [
      { id: "c-rename-old", repository_id: repoId, file_path: "src/legacy.js", chunk_index: 0, content: "legacy" },
    ],
  });

  const octokit = makeOctokitMock({
    commitSha: "sha-200",
    comparisonFiles: [
      {
        filename: "src/modern.js",
        previous_filename: "src/legacy.js",
        status: "renamed",
        sha: "blob-modern",
      },
    ],
    blobMap: {
      "blob-modern": { content: "const modern = true;\n", size: 22 },
    },
  });

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: silentLogger,
  });

  const res = await poller.pollRepository({ repositoryId: repoId });

  assert.equal(res.status, "updated");
  assert.equal(res.stats.renamed, 1);

  // Old path chunks deleted
  const oldChunks = supabase._store.code_chunks.filter((c) => c.file_path === "src/legacy.js");
  assert.equal(oldChunks.length, 0);

  // New path chunks indexed
  const newChunks = supabase._store.code_chunks.filter((c) => c.file_path === "src/modern.js");
  assert.equal(newChunks.length, 1);
  assert.match(newChunks[0].content, /modern = true/);
});

test("Feature 9 - Req 5: skips ineligible or excluded files (.png, .env, package-lock.json) and reports skipped in stats", async () => {
  const repoId = "repo-uuid-5";
  const supabase = makeSupabaseMock({
    initialRepos: [{ id: repoId, owner: "testowner", name: "testrepo", default_branch: "main" }],
    initialIndexStates: [
      { repository_id: repoId, indexed_commit_sha: "sha-100", status: "idle" },
    ],
    initialChunks: [],
  });

  const octokit = makeOctokitMock({
    commitSha: "sha-200",
    comparisonFiles: [
      { filename: "assets/logo.png", status: "added", sha: "blob-png" },
      { filename: ".env", status: "added", sha: "blob-env" },
      { filename: "package-lock.json", status: "modified", sha: "blob-lock" },
      { filename: "src/valid.js", status: "added", sha: "blob-valid" },
    ],
    blobMap: {
      "blob-valid": { content: "console.log('valid');\n", size: 25 },
    },
  });

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: silentLogger,
  });

  const res = await poller.pollRepository({ repositoryId: repoId });

  assert.equal(res.status, "updated");
  assert.equal(res.stats.skipped, 3, "Three files (.png, .env, package-lock.json) should be skipped");
  assert.equal(res.stats.added, 3);
  assert.equal(res.stats.modified, 1);

  // Only src/valid.js chunks stored
  const chunks = supabase._store.code_chunks;
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].file_path, "src/valid.js");
});

test("Feature 9 - Req 6: skips oversized files (> 100 KB) and deletes any prior chunks for them", async () => {
  const repoId = "repo-uuid-6";
  const supabase = makeSupabaseMock({
    initialRepos: [{ id: repoId, owner: "testowner", name: "testrepo", default_branch: "main" }],
    initialIndexStates: [
      { repository_id: repoId, indexed_commit_sha: "sha-100", status: "idle" },
    ],
    initialChunks: [
      { id: "c-huge", repository_id: repoId, file_path: "src/huge.js", chunk_index: 0, content: "old smaller huge" },
    ],
  });

  const octokit = makeOctokitMock({
    commitSha: "sha-200",
    comparisonFiles: [
      { filename: "src/huge.js", status: "modified", sha: "blob-huge" },
    ],
    blobMap: {
      "blob-huge": { content: "x".repeat(150 * 1024), size: 150 * 1024 }, // 150 KB > 100 KB
    },
  });

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: silentLogger,
  });

  const res = await poller.pollRepository({ repositoryId: repoId });

  assert.equal(res.status, "updated");
  assert.equal(res.stats.oversized, 1);

  // Chunks for huge.js were deleted because it is no longer eligible
  const chunks = supabase._store.code_chunks.filter((c) => c.file_path === "src/huge.js");
  assert.equal(chunks.length, 0);
});

test("Feature 9 - Req 7: updates stored indexed commit SHA only after all file updates succeed; failed run leaves prior SHA intact", async () => {
  const repoId = "repo-uuid-7";
  const supabase = makeSupabaseMock({
    initialRepos: [{ id: repoId, owner: "testowner", name: "testrepo", default_branch: "main" }],
    initialIndexStates: [
      { repository_id: repoId, indexed_commit_sha: "sha-100", status: "idle" },
    ],
    failOn: "chunks_insert",
  });

  const octokit = makeOctokitMock({
    commitSha: "sha-200",
    comparisonFiles: [
      { filename: "src/file.js", status: "added", sha: "blob-file" },
    ],
    blobMap: {
      "blob-file": { content: "code\n", size: 5 },
    },
  });

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: silentLogger,
  });

  const res = await poller.pollRepository({ repositoryId: repoId });

  assert.equal(res.status, "failed");

  // Check that indexed_commit_sha was NOT advanced
  const state = supabase._store.repository_index_state.find((s) => s.repository_id === repoId);
  assert.equal(state.indexed_commit_sha, "sha-100", "indexed_commit_sha must remain intact for retry");
  assert.equal(state.status, "failed");
  assert.match(state.last_error, /simulated code_chunks failure/);
});

test("Feature 9 - Req 8: updates are safe to retry and do not duplicate chunks", async () => {
  const repoId = "repo-uuid-8";
  const supabase = makeSupabaseMock({
    initialRepos: [{ id: repoId, owner: "testowner", name: "testrepo", default_branch: "main" }],
    initialIndexStates: [
      { repository_id: repoId, indexed_commit_sha: "sha-100", status: "idle" },
    ],
    initialChunks: [],
  });

  const octokit = makeOctokitMock({
    commitSha: "sha-200",
    comparisonFiles: [
      { filename: "src/module.js", status: "added", sha: "blob-mod" },
    ],
    blobMap: {
      "blob-mod": { content: "export const A = 1;\n", size: 20 },
    },
  });

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: silentLogger,
  });

  // First poll runs update
  const res1 = await poller.pollRepository({ repositoryId: repoId });
  assert.equal(res1.status, "updated");
  assert.equal(supabase._store.code_chunks.length, 1);

  // If retried with same SHA, poller recognizes up to date and does not duplicate
  const res2 = await poller.pollRepository({ repositoryId: repoId });
  assert.equal(res2.status, "unchanged");
  assert.equal(supabase._store.code_chunks.length, 1);
});

test("Feature 9 - Req 9: prevents concurrent or overlapping runs for the same repository", async () => {
  const repoId = "repo-uuid-9";
  const supabase = makeSupabaseMock({
    initialRepos: [{ id: repoId, owner: "testowner", name: "testrepo", default_branch: "main" }],
    initialIndexStates: [
      { repository_id: repoId, indexed_commit_sha: "sha-100", status: "idle" },
    ],
  });

  let resolveCommit;
  const slowCommitPromise = new Promise((resolve) => {
    resolveCommit = resolve;
  });

  const octokit = {
    rest: {
      repos: {
        get: async () => ({
          data: {
            owner: { login: "testowner" },
            name: "testrepo",
            full_name: "testowner/testrepo",
            default_branch: "main",
          },
        }),
        getCommit: async () => {
          await slowCommitPromise;
          return { data: { sha: "sha-100" } };
        },
      },
    },
  };

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: silentLogger,
  });

  // Launch first poll (will hang waiting for slowCommitPromise)
  const run1Promise = poller.pollRepository({ repositoryId: repoId });

  // Immediately launch second poll for same repository
  const run2Result = await poller.pollRepository({ repositoryId: repoId });

  // Second run was skipped to prevent overlapping execution
  assert.equal(run2Result.status, "skipped");
  assert.equal(run2Result.reason, "in_progress_locally");

  // Unblock first run
  resolveCommit();
  const run1Result = await run1Promise;
  assert.equal(run1Result.status, "unchanged");
});

test("Feature 9 - Req 10: pollAll() iterates over all tracked repositories and handles mixed results safely", async () => {
  const supabase = makeSupabaseMock({
    initialRepos: [
      { id: "repo-1", owner: "org", name: "repo1", default_branch: "main" },
      { id: "repo-2", owner: "org", name: "repo2", default_branch: "main" },
    ],
    initialIndexStates: [
      { repository_id: "repo-1", indexed_commit_sha: "sha-1", status: "idle" },
      { repository_id: "repo-2", indexed_commit_sha: "sha-old", status: "idle" },
    ],
  });

  const octokit = {
    rest: {
      repos: {
        get: async ({ repo }) => ({
          data: {
            owner: { login: "org" },
            name: repo,
            full_name: `org/${repo}`,
            default_branch: "main",
          },
        }),
        getCommit: async ({ repo }) => {
          if (repo === "repo1") return { data: { sha: "sha-1" } }; // Unchanged
          if (repo === "repo2") return { data: { sha: "sha-new" } }; // Changed
          return { data: { sha: "sha-x" } };
        },
        compareCommits: async () => ({
          data: {
            status: "ahead",
            files: [
              { filename: "README.md", status: "modified", sha: "blob-readme" },
            ],
          },
        }),
      },
      git: {
        getBlob: async () => ({
          data: {
            content: Buffer.from("# Docs\n").toString("base64"),
            encoding: "base64",
            size: 7,
          },
        }),
      },
    },
  };

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: silentLogger,
  });

  const outcome = await poller.pollAll();

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.count, 2);
  assert.equal(outcome.results[0].status, "unchanged");
  assert.equal(outcome.results[1].status, "updated");
});

test("Feature 9 - Req 11: background timer starts and stops cleanly with unref", async () => {
  const supabase = makeSupabaseMock();
  const octokit = makeOctokitMock();
  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    pollingIntervalMs: 5000,
    logger: silentLogger,
  });

  assert.equal(poller.timer, null);
  poller.start();
  assert.notEqual(poller.timer, null);
  poller.stop();
  assert.equal(poller.timer, null);
});

test("Feature 9 - Req 12: status and error reporting does not leak credentials or secret tokens", async () => {
  const repoId = "repo-uuid-12";
  const supabase = makeSupabaseMock({
    initialRepos: [{ id: repoId, owner: "testowner", name: "testrepo", default_branch: "main" }],
    initialIndexStates: [
      { repository_id: repoId, indexed_commit_sha: "sha-100", status: "idle" },
    ],
  });

  const octokit = makeOctokitMock({
    errorMode: "compare_error",
  });

  const githubService = new GithubIngestionService({ octokit });
  const chunkingService = new ChunkingService();
  const embeddingService = makeMockEmbeddingService();
  const repository = new RepositoriesRepository({ supabaseClient: supabase });

  const logs = [];
  const captureLogger = {
    log: (msg) => logs.push(msg),
    warn: (msg) => logs.push(msg),
    error: (msg) => logs.push(msg),
  };

  const poller = new PollingService({
    githubService,
    chunkingService,
    embeddingService,
    repository,
    logger: captureLogger,
  });

  const res = await poller.pollRepository({ repositoryId: repoId });

  assert.equal(res.status, "failed");
  assert.equal(typeof res.error, "string");
  // Ensure no sensitive headers or tokens in error
  assert.doesNotMatch(res.error, /Bearer|token|ghp_|secret|password/i);
  for (const log of logs) {
    assert.doesNotMatch(log, /Bearer|token|ghp_|secret|password/i);
  }
});
