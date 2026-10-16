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
- Backend entry point: `backend/src/index.js` (currently empty).
- Backend layer directories exist but are empty: `backend/src/controllers/`, `backend/src/repositories/`, and `backend/src/services/`.
- Installed backend dependencies: `express`, `@supabase/supabase-js`, `zod`, `dotenv`, `octokit`, and `@huggingface/transformers`.
- `backend/node_modules/` is installed and ignored by Git. The only known `.gitignore` entry is `/node_modules`.
- `backend/opencode.json` registers a **read-only Supabase MCP server** for database and documentation features. It can help inspect schema and documentation, but it cannot be used to write application data or make schema changes.
- `backend/package-lock.json` exists.
- There is no README, CI workflow, pre-commit configuration, or configured lockfile-based tooling beyond npm's package lock.

## Current architecture direction

These are the working design decisions discussed so far, not a claim that the implementation is already present:

1. **Node.js backend.** Keep API and pipeline orchestration in `backend/`. Use the existing ES module setup.
2. **GitHub API through Octokit.** Analyze one real repository for the MVP. Read relevant source, tests, dependency manifests, and deployment/configuration files; skip generated and vendored content where practical.
3. **Polling for repository changes.** Record the last successfully indexed commit SHA and periodically compare it with the latest SHA. Polling is the initial MVP approach; a webhook may be considered later.
4. **Code embeddings in Supabase Postgres with pgvector.** Store chunks with repository identity, file path, line range, commit SHA, chunk index, content, and embedding. Supabase is the vector store and structured application database.
5. **Hugging Face embeddings in JavaScript.** Use `@huggingface/transformers` for a compatible embedding model in Node.js. Use the same model and vector dimensions for repository chunks and requirement queries.
6. **LLM for extraction and assessment.** Use an LLM to turn one real job posting into structured requirements, then assess requirements against retrieved code evidence. The LLM provider is not yet selected.
7. **Evidence-first assessment.** Vector search retrieves candidate chunks; similarity is not proof of a skill. Have the LLM return a separate verdict for each requirement, with an explanation and repository file/line citations. Suggested statuses: `demonstrated`, `partial`, `not_demonstrated`, and `uncertain`.
8. **Batch assessment where practical.** Retrieve evidence separately for each requirement, group it by requirement, and send the groups in one structured LLM request when they fit the context window. Split into batches if needed.
9. **Incremental indexing.** For each changed file, generate replacement chunks and embeddings, then replace the old chunks for that repository/file. Remove chunks for deleted or newly excluded files. Handle renames by removing the old path and indexing the new path. Make updates idempotent and record the new indexed SHA only after all required indexing work succeeds.
10. **Before/after demo.** Show an initial assessment, make a real commit that changes relevant evidence, let polling trigger re-indexing and reassessment, and show the new result with citations.

## Suggested data records

Exact table names and schema are undecided. Keep the following concepts distinguishable:

- **Job posting:** source URL, fetched text, and fetch timestamp.
- **Requirement:** posting reference, stable requirement ID, skill, description, and evidence hints.
- **Code chunk:** repository, path, line range, commit SHA, chunk index, text, and embedding.
- **Assessment:** requirement ID, verdict, explanation, evidence references, repository SHA, and assessment timestamp.
- **Repository indexing state:** repository identity, last successfully indexed SHA, and processing status/error.

## Repository and command guidance

- Before running or adding commands, inspect `backend/package.json`. Do not assume `npm test`, `npm run dev`, build, or lint commands exist.
- At the supplied starting state, `npm test` is known to fail with `"no test specified" && exit 1`; no test runner is configured.
- If adding scripts, define them in `backend/package.json` and run them from `backend/`.
- Re-run `npm install` after changing `package.json` so `package-lock.json` stays in sync.
- Do not add a frontend stack until the team chooses one.
- Keep secrets out of source control and the frontend. Use environment configuration for tokens and service credentials; document required variable names without committing values.
- The Supabase MCP is read-only. Use normal application credentials and migrations or SQL under an explicitly authorized workflow for writes/schema changes; never assume the MCP can perform them.

## Still to decide

- Which LLM provider/model to use for requirement extraction and assessment.
- The exact embedding model, vector dimensions, and chunking strategy.
- The Supabase schema and migration approach.
- Polling interval and how the poller is hosted/run during the demo.
- The frontend framework and visualization of evidence.
- Whether to add tests and which test runner to configure.

Prefer the smallest implementation that proves the complete change-detection and reassessment loop. Optional resume editing, career research, learning plans, and multi-repository support are outside the initial MVP unless the team explicitly expands scope.
