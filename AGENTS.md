# Kuruckshetra-26 — Project Context

This file gives contributors the current project context, repository constraints, and working architecture for the Agentic AI hackathon project. Treat the repository facts below as the supplied starting state; verify them against the checkout before changing scripts or structure.

## Project goal

Build the **W-PS-2 AI Career Coach** MVP: compare a real job or internship posting with evidence in a real GitHub repository, explain which requirements are demonstrated in that repository, and automatically reassess when the repository changes.

The core demo loop is:

> Job requirements → repository evidence → evidence-backed assessment → repository change → updated assessment

A missing signal means **“not demonstrated in the analyzed repository”**, not proof that the student lacks the skill. Assessment claims should link to repository evidence.

## Repository starting state

- Git is initialized; the default branch is `master` and has no commits yet.
- Top-level directories: `backend/` and `frontend/`.
- `frontend/` is currently empty. No frontend framework or tooling has been selected; do not assume one.
- The backend is a Node.js package using ES modules (`"type": "module"`).
- Backend entry point: `backend/src/index.js` — Express server with `/api/job-postings` route, Supabase client, and Groq client wired up.
- Backend layer directories now contain: `backend/src/controllers/jobPostingsController.js`, `backend/src/repositories/jobPostingsRepository.js`, `backend/src/services/requirementExtractionService.js`, `backend/src/routes/jobPostingsRoutes.js`
- Installed backend dependencies: `express`, `@supabase/supabase-js`, `zod`, `dotenv`, `octokit`, `@huggingface/transformers`, and `groq-sdk`. Groq is wired up in `index.js` (exported as `groq`) for requirement extraction.
- `backend/node_modules/` is installed and ignored by Git. The only known `.gitignore` entry is `/node_modules`.
- `backend/opencode.json` registers a **read-only Supabase MCP server** for database and documentation features (`project_ref=qnkosqbumadydglpbgmo`). It can inspect schema and documentation, but cannot write data or change schema.
- `backend/package-lock.json` exists.
- There is no README, CI workflow, pre-commit configuration, or configured lockfile-based tooling beyond npm's package lock.

## Supabase schema (remote project)

The Supabase database already has 8 tables, all empty (0 rows), all with RLS enabled. This is the source of truth for data records — the "undecided" schema section below is resolved.

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

- Before running or adding commands, inspect `backend/package.json`. Available scripts: `npm run dev` / `npm start` (run `backend/src/index.js`), `npm test` (runs `node --test`).
- Run the server from `backend/` with `npm run dev`.
- Test routes: `GET /` (status), `GET /health` (Supabase reachability), `GET /test/groq` (Groq client configured?), `GET /test/groq/models` (list available Groq models and verify key).
- API endpoint: `POST /api/job-postings` — accepts `{ sourceUrl, postingText }`, extracts requirements via Groq, validates with Zod, persists to Supabase `job_postings` + `requirements` tables.
- Required env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY`), `GROQ_API_KEY`, `GROQ_MODEL`. See `backend/.env.example`.
- If adding scripts, define them in `backend/package.json` and run them from `backend/`.
- Re-run `npm install` after changing `package.json` so `package-lock.json` stays in sync.
- Do not add a frontend stack until the team chooses one.
- Keep secrets out of source control and the frontend. Use environment configuration for tokens and service credentials; document required variable names without committing values.
- The Supabase MCP is read-only. Use normal application credentials and migrations or SQL under an explicitly authorized workflow for writes/schema changes; never assume the MCP can perform them.
- Tests: `backend/src/jobPostings.test.js` uses Node's built-in `node:test` with mocked Groq and Supabase. Run with `npm test` from `backend/`.

## Embedding model

Chosen: **`Xenova/all-MiniLM-L6-v2`** (Hugging Face), **384 dimensions**. Runs in Node.js via the already-installed `@huggingface/transformers`. Record `embedding_model` and `embedding_dimensions` per chunk in `code_chunks` so a future model swap is detectable by query.

## LLM model

Chosen: **Groq** with **`qwen/qwen3.8-27b`** (configured via `GROQ_MODEL` env var). Confirmed supported for this account via `GET /test/groq/models`. Record `model_name` per assessment in `assessments` table. To change models, update `GROQ_MODEL` in `.env` and restart the server.

## Still to decide

- Chunking strategy (size, overlap, which file types to include/exclude).
- Polling interval and how the poller is hosted/run during the demo.
- The frontend framework and visualization of evidence.


Prefer the smallest implementation that proves the complete change-detection and reassessment loop. Optional resume editing, career research, learning plans, and multi-repository support are outside the initial MVP unless the team explicitly expands scope.
