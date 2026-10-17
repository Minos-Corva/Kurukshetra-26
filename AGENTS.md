# Kuruckshetra-26 — Project Context

This file gives contributors the current project context, repository constraints, and working architecture for the Agentic AI hackathon project. Treat the repository facts below as the supplied starting state; verify them against the checkout before changing scripts or structure.

## Project goal

Build the **W-PS-2 AI Career Coach** MVP: compare a real job or internship posting with evidence in a real GitHub repository, explain which requirements are demonstrated in that repository, and automatically reassess when the repository changes.

The core demo loop is:

> Job requirements → repository evidence → evidence-backed assessment → repository change → updated assessment

A missing signal means **“not demonstrated in the analyzed repository”**, not proof that the student lacks the skill. Assessment claims should link to repository evidence.

## Repository starting state

- Git is initialized. The default branch is `main`; feature work happens on branches (for example `feature-evidance-retrival`).
- Top-level directories: `backend/` and `frontend/`.
- `frontend/` is currently empty. No frontend framework or tooling has been selected; do not assume one.
- The backend is a Node.js package using ES modules (`"type": "module"`).
- Backend entry point: `backend/src/index.js` — Express server with `/api/job-postings`, `/api/repositories/ingest`, and `/api/evidence/retrieve` routes, Supabase client, Groq client, and Octokit wired up.
- Backend layer directories now contain:
  - Feature 3: `backend/src/controllers/jobPostingsController.js`, `backend/src/repositories/jobPostingsRepository.js`, `backend/src/services/requirementExtractionService.js`, `backend/src/routes/jobPostingsRoutes.js`
  - Feature 4 & 5 (chunking + embedding pipeline): `backend/src/controllers/repositoriesController.js`, `backend/src/repositories/repositoriesRepository.js`, `backend/src/routes/repositoriesRoutes.js`, `backend/src/services/githubIngestionService.js`, `backend/src/services/chunkingService.js`, `backend/src/services/embeddingService.js`
  - Feature 6 (evidence retrieval): `backend/src/controllers/evidenceController.js`, `backend/src/repositories/evidenceRepository.js`, `backend/src/services/evidenceService.js`, `backend/src/routes/evidenceRoutes.js`
  - Test files: `backend/src/jobPostings.test.js`, `backend/src/repositories.test.js`, `backend/src/chunking-embedding.test.js` (Feature 5 focused checks, 17 tests), `backend/src/evidence.test.js` (Feature 6, 14 tests)
  - Smoke test: `backend/src/smoke-test-ingest.js` (run with `npm run smoke-test [owner] [repo]`)

- Installed backend dependencies: `express`, `@supabase/supabase-js`, `zod`, `dotenv`, `octokit`, `@huggingface/transformers`, and `groq-sdk`. Groq is wired up in `index.js` (exported as `groq`) for requirement extraction.
- `backend/node_modules/` is installed and ignored by Git. The only known `.gitignore` entry is `/node_modules`.
- `backend/opencode.json` registers a **read-only Supabase MCP server** for database and documentation features (`project_ref=qnkosqbumadydglpbgmo`). It can inspect schema and documentation, but cannot write data or change schema.
- `backend/package-lock.json` exists.
- There is no README, CI workflow, pre-commit configuration, or configured lockfile-based tooling beyond npm's package lock.

## Supabase schema (remote project)

The Supabase database already has 8 tables, all with RLS enabled. (The tables start empty; running the API — ingesting a repository or creating a posting — populates them.) This is the source of truth for data records — the "undecided" schema section below is resolved.

| Table | Purpose |
|---|---|
| `job_postings` | One fetched job posting: `id uuid PK`, `source_url`, `title`, `company`, `raw_text`, `fetched_at`, `created_at`. FK target for `requirements` and `assessments`. |
| `requirements` | Structured requirements extracted from a posting: `id uuid PK`, `job_posting_id FK`, `requirement_key` (stable ID across re-extraction), `skill`, `description`, `evidence_hints text[]`, `source_excerpt`, `sort_order`. |
| `repositories` | The GitHub repo being analyzed: `id uuid PK`, `owner`, `name`, generated `full_name` (`owner || '/' || name`), `html_url`, `default_branch`. FK target for `code_chunks`, `repository_index_state`, `assessments`. |
| `repository_index_state` | Change-detection state, 1:1 with `repositories` (`repository_id` is PK). `indexed_commit_sha`, `latest_seen_commit_sha`, `status` (`idle|running|failed`), `last_success_at`, `last_error`. Poller's working memory. |
| `code_chunks` | pgvector store: `id uuid PK`, `repository_id FK`, `file_path`, `chunk_index >= 0`, `content`, `start_line`/`end_line`, `commit_sha`, `blob_sha`, `embedding_model`, `embedding_dimensions > 0`, `embedding vector`. Records model/dimensions per chunk so swaps are detectable by query. |
| `assessments` | One assessment run: `id uuid PK`, `job_posting_id FK`, `repository_id FK`, `commit_sha`, `model_name`, `created_at`. A new commit SHA = a new assessment row (enables before/after demo). |
| `requirement_assessments` | Per-requirement verdict: `id uuid PK`, `assessment_id FK`, `requirement_id FK`, `status` (CHECK: `demonstrated|partial|not_demonstrated|uncertain`), `explanation`, `confidence 0–1`. |
| `assessment_evidence` | Citation layer linking a verdict to code: `id uuid PK`, `requirement_assessment_id FK`, nullable `code_chunk_id FK`, plus duplicated `file_path`, `start_line`/`end_line`, `commit_sha`, `quote`, `source_url`. Duplication is deliberate — verdicts stay readable after chunks are deleted or re-indexed. |

## Current architecture direction

These are the working design decisions discussed so far:

1. **Node.js backend.** Keep API and pipeline orchestration in `backend/`. Use the existing ES module setup.
2. **GitHub API through Octokit.** Analyze one real repository for the MVP. Read relevant source, tests, dependency manifests, and deployment/configuration files; skip generated and vendored content where practical.
3. **Polling for repository changes.** Record `indexed_commit_sha` vs `latest_seen_commit_sha` in `repository_index_state` and periodically compare. Polling is the initial MVP approach; a webhook may be considered later.
4. **Code embeddings in Supabase Postgres with pgvector.** Store chunks in `code_chunks`. Supabase is the vector store and structured application database.
5. **Hugging Face embeddings in JavaScript.** Use `@huggingface/transformers` for a compatible embedding model in Node.js. Use the same model and vector dimensions for repository chunks and requirement queries.
6. **LLM for extraction and assessment.** Use Groq (`qwen/qwen3.8-27b` via `GROQ_MODEL` env var) to turn one real job posting into structured requirements (`requirements`), then assess requirements against retrieved code evidence (`requirement_assessments`).
7. **Evidence-first assessment.** Vector search retrieves candidate chunks; similarity is not proof of a skill. Have the LLM return a separate verdict per requirement, with explanation and repository file/line citations stored in `assessment_evidence`.
8. **Batch assessment where practical.** Retrieve evidence separately per requirement, group by requirement, and send groups in one structured LLM request when they fit the context window. Split into batches if needed.
9. **Incremental indexing.** For each changed file, generate replacement chunks and embeddings in `code_chunks`, then replace old chunks for that repository/file. Remove chunks for deleted or newly excluded files. Handle renames by removing the old path and indexing the new path. Make updates idempotent and record the new indexed SHA only after all indexing work succeeds.
10. **Before/after demo.** Show an initial assessment, make a real commit that changes relevant evidence, let polling trigger re-indexing and reassessment, and show the new result with citations.

## Repository and command guidance

- Before running or adding commands, inspect `backend/package.json`. Available scripts: `npm run dev` / `npm start` (run `backend/src/index.js`), `npm test` (runs `node --test`), `npm run smoke-test [owner] [repo]` (manual ingest smoke test, requires a running server).
- Run the server from `backend/` with `npm run dev`.
- Test routes: `GET /` (status), `GET /health` (Supabase reachability), `GET /test/groq` (Groq client configured?), `GET /test/groq/models` (list available Groq models and verify key).
- API endpoint: `POST /api/job-postings` — accepts `{ sourceUrl, postingText }`, extracts requirements via Groq, validates with Zod, persists to Supabase `job_postings` + `requirements` tables.
- API endpoint: `POST /api/repositories/ingest` — accepts `{ owner, name, branch? }`, fetches GitHub files, chunks, embeds, and persists to `repositories`, `repository_index_state`, and `code_chunks`. Idempotent on same commit SHA.
- API endpoint: `POST /api/evidence/retrieve` (alias `POST /api/evidence`) — accepts `{ jobPostingId? , assessmentId?, repositoryId? , owner?, name?, matchCount?, similarityThreshold? }`. Requires either `jobPostingId` or `assessmentId`; repository scope is `repositoryId` or `owner` + `name` (not needed when `assessmentId` is given). Returns per-requirement candidate chunks with `chunkId`, `similarity`, `filePath`, `lineRange`, `content`, and a commit-pinned `sourceUrl`. A requirement with no matches returns an **empty** evidence list — never a claim that the skill is absent. Errors: `400` invalid input, `404` posting/assessment/repository/requirements not found, `422` repository not indexed, `500` embedding/database failure.
- Required env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY`), `GROQ_API_KEY`, `GROQ_MODEL`. See `backend/.env.example`. `GITHUB_TOKEN` is optional (increases rate limit from 60 to 5000 req/hr).
- If adding scripts, define them in `backend/package.json` and run them from `backend/`.
- Re-run `npm install` after changing `package.json` so `package-lock.json` stays in sync.
- Do not add a frontend stack until the team chooses one.
- Keep secrets out of source control and the frontend. Use environment configuration for tokens and service credentials; document required variable names without committing values.
- The Supabase MCP is read-only. Use normal application credentials and migrations or SQL under an explicitly authorized workflow for writes/schema changes; never assume the MCP can perform them.
- Tests: `backend/src/jobPostings.test.js` and `backend/src/repositories.test.js` use Node's built-in `node:test` with mocked dependencies. `backend/src/chunking-embedding.test.js` contains focused Feature 5 checks (17 tests). `backend/src/evidence.test.js` contains Feature 6 checks (14 tests, mocked Supabase/embeddings). Run all with `npm test` from `backend/`. Total: 46 tests, all passing.

## Embedding model

Chosen: **`jinaai/jina-embeddings-v2-base-code`** (Hugging Face), **768 dimensions**. Runs in Node.js via the already-installed `@huggingface/transformers`. The model is loaded lazily on first ingest call and cached as a singleton for the lifetime of the server process. Mean pooling and L2 normalization are applied; embeddings are verified to be exactly 768-dimensional before any Supabase write. Record `embedding_model` and `embedding_dimensions` per chunk in `code_chunks` so a future model swap is detectable by query. First load downloads ~350 MB; subsequent runs use the `@huggingface/transformers` local cache.

## Chunking strategy

Line-based, deterministic, implemented in `backend/src/services/chunkingService.js`.

| Parameter | Default | Notes |
|---|---|---|
| `chunkSize` | 60 lines | Lines per chunk |
| `overlap` | 10 lines | Lines shared with the next chunk (step = chunkSize − overlap = 50) |
| Max file size | 100 KB | Files larger than this are skipped during GitHub fetch |
| Max file count | 300 files | Per ingest call |
| Max total bytes | 5 MB | Across all files per ingest call |

- Each chunk carries `file_path`, `chunk_index` (0-indexed, reset per file), `start_line`/`end_line` (1-indexed, inclusive), `commit_sha`, and `blob_sha`.
- Pure-whitespace chunks are skipped.
- Same file + same commit SHA always produces the same chunk sequence (deterministic).
- Excluded from indexing: binary files, lockfiles, minified bundles, `node_modules/`, `dist/`, `build/`, and other generated directories (see `githubIngestionService.js` for the full exclusion lists).

## Vector search RPC (evidence retrieval)

The evidence endpoint queries code chunks through a Supabase Postgres function. The **deployed signature is the source of truth**:

```sql
match_code_chunks(
  p_repository_id   uuid,
  p_embedding_model text,
  p_query_embedding vector,
  p_match_count     integer DEFAULT 10
) RETURNS TABLE(
  chunk_id uuid, file_path text, start_line integer,
  end_line integer, commit_sha text, content text, similarity real
)
```

- It filters by `repository_id`, `embedding_model`, and `embedding_dimensions = vector_dims(p_query_embedding)`, orders by cosine distance, and caps results at 50.
- It has **no similarity-threshold argument** — `similarityThreshold` is applied client-side in `evidenceRepository.matchCodeChunks`.
- The returned key is **`chunk_id`** (not `id`); the repository normalizes it to `id` before mapping to the API response.
- `evidenceRepository.matchCodeChunks` calls the deployed signature first (passing the model name from `EmbeddingService.model`) and falls back to older parameter shapes (`filter_repository_id` / `repository_id` / 3-arg) if the function is missing.
- There are **no SQL migration files in the repo**; the function lives only in the remote database. If the signature changes, update `evidenceRepository.js` and `evidence.test.js` to match.

## LLM model

Chosen: **Groq** with **`qwen/qwen3.8-27b`** (configured via `GROQ_MODEL` env var). Confirmed supported for this account via `GET /test/groq/models`. Record `model_name` per assessment in `assessments` table. To change models, update `GROQ_MODEL` in `.env` and restart the server.

## Implementation status

- **Implemented and verified live:** requirement extraction (`POST /api/job-postings` → Groq), repository ingestion/chunking/embedding (`POST /api/repositories/ingest`), evidence retrieval with citations (`POST /api/evidence/retrieve`), and the change-detection *data model* in `repository_index_state` (re-ingesting the same commit SHA is a no-op; chunks are replaced when the SHA changes).
- **Not implemented yet:** the poller that watches for new commits, and the assessment/reassessment step. The `assessments`, `requirement_assessments`, and `assessment_evidence` tables exist but nothing writes them, and there is no assessment endpoint.

## Still to decide

- Polling interval and how the poller is hosted/run during the demo.
- The frontend framework and visualization of evidence.


Prefer the smallest implementation that proves the complete change-detection and reassessment loop. Optional resume editing, career research, learning plans, and multi-repository support are outside the initial MVP unless the team explicitly expands scope.
