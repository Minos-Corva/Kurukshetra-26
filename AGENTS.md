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
- `frontend/` contains the Feature 8 assessment UI: plain HTML/CSS/JavaScript (ES modules) with **no framework, no build step, and no dependencies**. Files: `frontend/index.html`, `frontend/styles.css`, `frontend/app.js`, `frontend/config.js`. There is no frontend `package.json`, no test runner, and no lint/format config.
- The backend is a Node.js package using ES modules (`"type": "module"`).
- Backend entry point: `backend/src/index.js` — Express server with `/api/job-postings`, `/api/repositories/ingest`, `/api/evidence/retrieve`, and `/api/assessments` routes, Supabase client, Groq client, and Octokit wired up.
- Backend layer directories now contain:
  - Feature 3: `backend/src/controllers/jobPostingsController.js`, `backend/src/repositories/jobPostingsRepository.js`, `backend/src/services/requirementExtractionService.js`, `backend/src/routes/jobPostingsRoutes.js`
  - Feature 4 & 5 (chunking + embedding pipeline): `backend/src/controllers/repositoriesController.js`, `backend/src/repositories/repositoriesRepository.js`, `backend/src/routes/repositoriesRoutes.js`, `backend/src/services/githubIngestionService.js`, `backend/src/services/chunkingService.js`, `backend/src/services/embeddingService.js`
  - Feature 6 (evidence retrieval): `backend/src/controllers/evidenceController.js`, `backend/src/repositories/evidenceRepository.js`, `backend/src/services/evidenceService.js`, `backend/src/routes/evidenceRoutes.js`
  - Feature 7 (requirement assessment): `backend/src/controllers/assessmentsController.js`, `backend/src/repositories/assessmentRepository.js`, `backend/src/services/assessmentService.js`, `backend/src/routes/assessmentsRoutes.js`
  - Feature 8 (assessment display UI): `frontend/index.html`, `frontend/styles.css`, `frontend/app.js`, `frontend/config.js` (no backend modules added; `backend/src/index.js` gained a static mount only)
  - Feature 9 (polling & incremental updates): `backend/src/services/pollingService.js`, `backend/src/poll-repositories.js`, updated `backend/src/repositories/repositoriesRepository.js`, updated `backend/src/services/githubIngestionService.js`, wired in `backend/src/index.js`
  - Test files: `backend/src/jobPostings.test.js`, `backend/src/repositories.test.js`, `backend/src/chunking-embedding.test.js` (Feature 5 focused checks, 17 tests), `backend/src/evidence.test.js` (Feature 6, 14 tests), `backend/src/assessments.test.js` (Feature 7, 16 tests), `backend/src/polling.test.js` (Feature 9, 12 tests)
  - Smoke tests / CLI scripts: `backend/src/smoke-test-ingest.js` (run with `npm run smoke-test [owner] [repo]`), `backend/src/poll-repositories.js` (run with `npm run poll` or `npm run poll:watch`)

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
8. **Batch assessment where practical.** Retrieve evidence separately per requirement, group by requirement, and send groups in one structured LLM request when they fit the context window. Split into bounded batches (Feature 7 uses batches of at most 5) when they do not — the Groq on-demand tier's input/output token limits make one request per requirement both slow and wasteful. See **Requirement assessment (Feature 7)**.
9. **Incremental indexing.** For each changed file, generate replacement chunks and embeddings in `code_chunks`, then replace old chunks for that repository/file. Remove chunks for deleted or newly excluded files. Handle renames by removing the old path and indexing the new path. Make updates idempotent and record the new indexed SHA only after all indexing work succeeds.
10. **Before/after demo.** Show an initial assessment, make a real commit that changes relevant evidence, let polling trigger re-indexing and reassessment, and show the new result with citations.

## Repository and command guidance

- Before running or adding commands, inspect `backend/package.json`. Available scripts: `npm run dev` (runs `backend/src/index.js` with `node --watch`, so backend source edits restart the server automatically), `npm start` (runs `backend/src/index.js` once, no watcher), `npm test` (runs `node --test`), `npm run smoke-test [owner] [repo]` (manual ingest smoke test, requires a running server).
- Run the server from `backend/` with `npm run dev`. Because it uses `node --watch`, editing a backend source file restarts the process, so `/app/` stays in sync with the checkout. A server started with `npm start` (or from an older checkout) must be restarted by hand, otherwise it can 404 on `/app/` even though the current `index.js` mounts it.
- Test routes: `GET /` (status; now also reports `ui: "/app/"`), `GET /health` (Supabase reachability), `GET /test/groq` (Groq client configured?), `GET /test/groq/models` (list available Groq models and verify key). `GET /app/` serves the Feature 8 static UI from the same origin.
- API endpoint: `POST /api/job-postings` — accepts `{ sourceUrl, postingText }`, extracts requirements via Groq, validates with Zod, persists to Supabase `job_postings` + `requirements` tables.
- API endpoint: `POST /api/repositories/ingest` — accepts `{ owner, name, branch? }`, fetches GitHub files, chunks, embeds, and persists to `repositories`, `repository_index_state`, and `code_chunks`. Idempotent on same commit SHA.
- API endpoint: `POST /api/evidence/retrieve` (alias `POST /api/evidence`) — accepts `{ jobPostingId? , assessmentId?, repositoryId? , owner?, name?, matchCount?, similarityThreshold? }`. Requires either `jobPostingId` or `assessmentId`; repository scope is `repositoryId` or `owner` + `name` (not needed when `assessmentId` is given). Returns per-requirement candidate chunks with `chunkId`, `similarity`, `filePath`, `lineRange`, `content`, and a commit-pinned `sourceUrl`. A requirement with no matches returns an **empty** evidence list — never a claim that the skill is absent. Errors: `400` invalid input, `404` posting/assessment/repository/requirements not found, `422` repository not indexed, `500` embedding/database failure.
- API endpoint: `POST /api/assessments` (alias `POST /api/assessments/run`) — accepts the same identifiers as evidence retrieval (`{ jobPostingId?, assessmentId?, repositoryId?, owner?, name?, matchCount?, similarityThreshold? }`), reuses Feature 6 to retrieve evidence per requirement, then asks Groq for one verdict per requirement. Returns `201` with the new assessment (`{ assessment, created, requirementsCount, results[] }`) or `200` when replaying an existing assessment for the same commit SHA. Errors: `400` invalid input, `404` posting/assessment/requirements not found, `422` repository not indexed, `502` unusable model output, `500` embedding/database failure. See **Requirement assessment (Feature 7)** below.
- Required env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY`), `GROQ_API_KEY`, `GROQ_MODEL`. See `backend/.env.example`. `GITHUB_TOKEN` is optional (increases rate limit from 60 to 5000 req/hr).
- If adding scripts, define them in `backend/package.json` and run them from `backend/`.
- Re-run `npm install` after changing `package.json` so `package-lock.json` stays in sync.
- Do not add a frontend build tool, framework, or package manager without a team decision. Feature 8 is intentionally dependency-free and served by the existing Express server (see **Frontend (Feature 8)**).
- Keep secrets out of source control and the frontend. Use environment configuration for tokens and service credentials; document required variable names without committing values. The browser only talks to the backend API; it never holds Supabase, Groq, or GitHub credentials.
- The Supabase MCP is read-only. Use normal application credentials and migrations or SQL under an explicitly authorized workflow for writes/schema changes; never assume the MCP can perform them.
- Tests: `backend/src/jobPostings.test.js` and `backend/src/repositories.test.js` use Node's built-in `node:test` with mocked dependencies. `backend/src/chunking-embedding.test.js` contains focused Feature 5 checks (17 tests). `backend/src/evidence.test.js` contains Feature 6 checks (14 tests, mocked Supabase/embeddings). `backend/src/assessments.test.js` contains Feature 7 checks (16 tests, mocked retrieval/Groq/persistence). Run all with `npm test` from `backend/`. Total: 62 tests, all passing.

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

- The account is on Groq's **on-demand tier**, which is tightly rate-limited for this model (observed: `7000` input tokens/minute and `1000` output tokens/minute per request). Prompts must stay under those ceilings — see the assessment section for how requests are bounded.
- **Every Groq call must send an explicit `max_tokens`.** The OTPM limit is enforced as a *pre-flight* check on the request's expected output, so a request without `max_tokens` is rejected up front even when little has been generated: `429 rate_limit_exceeded ... OTPM: Limit 1000, Requested 1592. The request's expected output tokens exceed the enforced limit`. This is deterministic, so the SDK's built-in retry does not help. Requirement extraction sends `max_tokens: 900` (`RequirementExtractionService.maxOutputTokens`); assessment sends `min(999, batchSize × 200 + 150)`. Both are constructor options — tune them if the tier limit changes.
- `qwen/qwen3.8-27b` supports JSON mode (`response_format: { type: "json_object" }`), which is used by both requirement extraction and assessment.

## Requirement assessment (Feature 7)

Implemented in `assessmentService.js` (orchestration + validation), `assessmentRepository.js` (persistence + status mapping), `assessmentsController.js` (HTTP + error mapping), and `assessmentsRoutes.js`.

**Route:** `POST /api/assessments` (alias `POST /api/assessments/run`). Required configuration is the same as the other features: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY`), `GROQ_API_KEY`, `GROQ_MODEL`; `GITHUB_TOKEN` optional.

**Request:** the same identifiers as evidence retrieval — `jobPostingId` or `assessmentId`, and repository scope `repositoryId` or `owner` + `name` (not needed when `assessmentId` is given). `matchCount` (default 5) and `similarityThreshold` (default 0.5) are forwarded to the Feature 6 retrieval service.

**Flow:** resolve posting/repository and retrieve per-requirement evidence via `EvidenceService.retrieveEvidence` (no second vector search or embedding logic) → build one structured Groq request per bounded batch → validate the response with Zod plus completeness and grounding checks — then persist one `assessments` row, one `requirement_assessments` verdict per requirement, and `assessment_evidence` citations.

**Statuses (API):** `supported`, `partial`, `not_found`.

- `supported` = the retrieved evidence clearly demonstrates the requirement.
- `partial` = the evidence demonstrates only part of it.
- `not_found` means **“not demonstrated in the analyzed repository”**, never proof the candidate lacks the skill. Requirements with no retrieved evidence are returned as `not_found` with an explanatory note.
- **Database mapping (important):** the pre-applied `requirement_assessments.status` CHECK only permits `demonstrated | partial | not_demonstrated | uncertain`, so `assessmentRepository.js` maps `supported → demonstrated`, `partial → partial`, `not_found → not_demonstrated` on write and back on read. The API always speaks `supported | partial | not_found`. (`uncertain` is passed through defensively if a row was written elsewhere.) No schema change was made.

**Per-requirement response** (in `results[]`): `requirementId`, `requirementKey`, `skill`, `description`, `status`, `explanation`, `confidence`, and `evidence[]` where each citation has `evidenceId`/`chunkId`, `filePath`, `startLine`, `endLine`, `lineRange`, `similarity` (when freshly computed), and a commit-pinned `sourceUrl`.

**Validation and safety:**
- The model must return exactly one result per requirement (matched by `requirement_id`); missing, duplicate, or unknown requirement IDs reject the whole run (`502`) and nothing is persisted.
- A `supported`/`partial` verdict with no citation that retrieval actually returned is rejected as ungrounded (`502`) — the model cannot invent evidence.
- Retrieved code is passed as untrusted data; the system prompt instructs the model to analyze it as evidence and never follow instructions found inside it.
- Malformed JSON, schema-invalid output, and Groq failures all fail safely (`502`) without storing a misleading assessment.

**Bounded requests (Groq tier limits):** requirements are grouped into batches of at most `5` and the prompt is trimmed (`maxEvidencePerRequirement = 3`, `maxEvidenceChars = 400`, `maxTextChars = 300`). `max_tokens` is set per batch (`min(999, batchSize × 200 + 150)`) so the request stays within the output-token ceiling. Number of Groq calls is `ceil(requirements / 5)` — never one call per requirement. A typical 10-requirement posting is assessed in 2 calls. These knobs are constructor options on `AssessmentService`; widen them only if the Groq tier limit changes.

**Idempotency:** there is no unique constraint on `assessments`, so `assessmentRepository.findExistingAssessment` looks up `(job_posting_id, repository_id, commit_sha)` and the service returns the stored assessment (`created: false`, HTTP `200`) instead of re-running the model. A new commit SHA produces a new row.

## Frontend (Feature 8)

The UI is plain HTML/CSS/JavaScript with **no framework, no build step, and no dependencies**. It calls only the existing backend API; it never calls Groq or vector search, and it never decides a status — it displays the assessment exactly as the backend returned it.

- `frontend/index.html` — the flow (job posting → repository → assess → results), a "Flow status" panel, and a status legend.
- `frontend/styles.css` — dependency-free styles; responsive single-column layout, `prefers-color-scheme` support, and status indicators that pair a text label with a symbol (never color alone).
- `frontend/app.js` — API client and rendering. Builds DOM with `textContent` only (no `innerHTML`), so untrusted model text cannot inject markup.
- `frontend/config.js` — runtime config: `window.__KURUKSHETRA_CONFIG__ = { API_BASE_URL: "" }`. Empty means "the origin that served the page". Never put secrets here.

**Serving:** `backend/src/index.js` mounts `express.static` at `/app` (directory from the optional `FRONTEND_DIR` env var, default `../frontend`). Open `http://localhost:3000/app/`. Same-origin means no CORS middleware is needed and none was added; `GET /` still returns JSON.

**Endpoints used (all pre-existing):** `POST /api/job-postings`, `POST /api/repositories/ingest`, `POST /api/assessments`. No API route was added or changed.

**Confirmed behavior (verified in a browser against the live backend):**
- Submitting a posting stores `posting.id` and lists the extracted requirements. The requirement list is not re-fetchable because there is **no `GET` endpoint** for job postings; the UI offers "Use an existing posting ID" (UUID) instead.
- Indexing shows `repository.id`, `indexedCommitSha`, `fileCount`, `chunkCount`, and `status`, and can be run again safely (idempotent). There is **no endpoint that reports index status on its own**, so status comes from the ingest response.
- Assess stays disabled until a posting ID and a repository scope (`repositoryId`, or `owner` + `name`) are present. Progress is shown while a request runs, and inputs are preserved after an error.
- Results render one card per requirement: skill, description, status badge (`supported` / `partial` / `not_found`, plus a defensive `uncertain`), explanation, confidence, and evidence with `filePath`, `lineRange`, repository, and a commit-pinned GitHub `sourceUrl`. "Not found" cards state that this means **not demonstrated in the analyzed repository**, and cards with no evidence show an explicit empty message.
- API errors surface only the backend's sanitized `error` / `message` / `details` — never raw response text.
- `GET /app/` scores 1.0 for Lighthouse accessibility, best practices, and SEO, both on load and with a full assessment rendered.

## GitHub commit polling and incremental repository updates (Feature 9)

Implemented in `backend/src/services/pollingService.js`, `backend/src/poll-repositories.js`, `backend/src/repositories/repositoriesRepository.js`, `backend/src/services/githubIngestionService.js`, and `backend/src/index.js`. Tested in `backend/src/polling.test.js` (12 tests; total test suite is 74 tests, all passing).

**Goal:** Watch configured GitHub repositories on their target branches for new commits. When the branch advances, update the indexed code incrementally so changed files have current chunks and embeddings, deleted files have their stale chunks removed, and unchanged files are never reprocessed.

**Execution modes:**
- **Single cycle (CLI / manual verification):** `npm run poll` (or `node src/poll-repositories.js`) checks all tracked repositories once and logs a summary table. Single repository: `node src/poll-repositories.js <owner> <repo> [branch]`.
- **Continuous watcher (CLI):** `npm run poll:watch` (or `node src/poll-repositories.js --watch`) runs continuously with interval defined by `POLL_INTERVAL_SECONDS` (default 60s).
- **In-process background daemon:** Setting `ENABLE_POLLING=true` in `.env` starts the `PollingService` timer on server boot (`pollingService.start()`). Interval configured via `POLL_INTERVAL_SECONDS` (default 60s).
- **Protected HTTP endpoint:** `POST /api/polling/run` allows triggering polling via HTTP only when `POLLING_SECRET` is configured in `.env` and sent in the `x-polling-secret` header. If `POLLING_SECRET` is unset, the endpoint returns `404`; if the header is incorrect, it returns `401`. Arbitrary callers cannot trigger polling unauthenticated.

**Incremental update workflow:**
1. Loads tracked repositories from `repositories` and `repository_index_state`.
2. Resolves target branch (`branch` or `default_branch` or `"main"`) and fetches latest commit SHA from GitHub via Octokit (`repos.getCommit`).
3. Compares `latestCommitSha` against `repository_index_state.indexed_commit_sha`:
   - If identical, skips processing immediately (`status: "unchanged"`). Chunks and embeddings are not touched.
   - If `indexed_commit_sha` is null (never indexed before), runs initial ingestion (`ingestRepository` + chunk + embed + persist).
   - If commit has advanced:
     a. Sets repository index state to `running` with `latest_seen_commit_sha = latestCommitSha`.
     b. Fetches commit comparison from GitHub via `repos.compareCommits`.
     c. Categorizes changed files:
        - `removed`: deletes all chunks where `file_path = filename`.
        - `renamed`: deletes chunks for `previous_filename` and `filename`; checks eligibility of `filename` (if eligible & within size limit, fetches blob, chunks, embeds, and inserts).
        - `modified` / `changed`: deletes existing chunks for `filename`; if eligible, fetches blob, chunks, embeds, and inserts new chunks.
        - `added` / `copied`: deletes any existing chunks for `filename` (for retry idempotency); if eligible, fetches blob, chunks, embeds, and inserts new chunks.
        - Excluded/unsupported files (e.g. `.png`, `.env`, `package-lock.json`, minified files) and oversized files (> 100 KB) are skipped and counted in stats. Any previous chunks for files that grew oversized or became ineligible are deleted.
     d. Embeds only the new/modified chunks in batches via `EmbeddingService.embedChunks`.
     e. Executes database updates: removes stale chunks (`deleteChunksForFiles`), inserts new chunks (`insertChunks`), and updates index state to `idle` (`updateIndexStateSuccess`).
     f. `indexed_commit_sha` is advanced ONLY after all file deletions, chunk insertions, and state updates succeed.
     g. If an error occurs midway, `indexed_commit_sha` is left intact at the old SHA and status is marked `failed` so the subsequent poll retries the diff.

**Concurrency & overlap prevention:**
- In-process mutex (`activeRepoRuns = new Set()`) prevents overlapping poll runs for the same repository.
- DB guard checks if a repository was marked `running` recently (< 10 minutes ago) to avoid collision across workers.

**Logging & credential safety:**
- Logs only repository name, old/new commit SHAs, file change counts (+added, ~modified, -deleted, ->renamed, skipped, oversized), and chunk metrics.
- Never logs credentials, tokens, or source file contents.

## Implementation status

- **Implemented and verified live:** requirement extraction (`POST /api/job-postings` → Groq), repository ingestion/chunking/embedding (`POST /api/repositories/ingest`), evidence retrieval with citations (`POST /api/evidence/retrieve`), requirement-by-requirement assessment with persisted verdicts and citations (`POST /api/assessments`), change-detection & commit polling (`PollingService`, `npm run poll`, `npm run poll:watch`, `POST /api/polling/run` with `POLLING_SECRET`), and the change-detection *data model* in `repository_index_state`.
- **Frontend verified:** the Feature 8 UI at `GET /app/` was driven end-to-end in a browser against the live backend (posting → index `expressjs/cors` → assess → 10 rendered requirement cards with 13 commit-pinned evidence links; a `422` unindexed-repository error and a preserved-input error path were also exercised). `GET /app/` scored 1.0 on Lighthouse accessibility, best practices, and SEO.
- **Missing endpoints the UI works around:** there is no `GET` for job postings, repositories, or past assessments, and no endpoint that reads index status on its own. The UI therefore relies on IDs returned by the write endpoints (or manual entry) and on the ingest response for index status.
- **Automatic reassessment trigger:** Polling advances index state and updates chunks incrementally; the final integration hook that automatically triggers reassessment following a successful incremental update is ready to be connected once the reassessment strategy (immediate run vs user-notified) is finalized.

## Still to decide

- Hosting and deployment model for long-running poller in production (e.g., background daemon process in container, external cron/scheduled task calling `npm run poll`, or serverless scheduled invocation via protected `POST /api/polling/run`).
- Automatic reassessment strategy: whether a commit advancement should immediately trigger an LLM reassessment run in the background or flag the repository as "update available" for user-triggered reassessment.
- Frontend framework: **decided** — dependency-free vanilla HTML/CSS/JS served at `/app` (see **Frontend (Feature 8)**). Revisit only if the team wants a framework and a build step.
- Further UI work (not started): a picker for existing postings/repositories/assessments, which needs new `GET` endpoints; and richer evidence display (code excerpts / diff view) beyond the current file + line-range links.

Prefer the smallest implementation that proves the complete change-detection and reassessment loop. Optional resume editing, career research, learning plans, and multi-repository support are outside the initial MVP unless the team explicitly expands scope.
