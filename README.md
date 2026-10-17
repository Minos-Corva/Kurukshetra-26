# W-PS-2 AI Career Coach

Compare a real job or internship posting with evidence in a real GitHub repository. See which requirements are demonstrated — with citations back to the code.

## Quick start

### 1. Prerequisites

- **Node.js 22+**
- A **Supabase** project with the schema applied (see [Supabase schema](#supabase-schema))
- A **Groq** API key ([console.groq.com](https://console.groq.com))
- *(Optional)* A **GitHub personal access token** (raises rate limit from 60 → 5,000 req/hr)

### 2. Backend environment

```bash
cp backend/.env.example backend/.env
# Edit backend/.env and fill in real values:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY, GROQ_MODEL
#   GITHUB_TOKEN (optional)
```

### 3. Install backend dependencies

```bash
cd backend
npm install
```

### 4. Start the backend

```bash
# Development (auto-restarts on file changes):
npm run dev

# Production (one-shot):
npm start
```

The server listens on `http://localhost:3000` (or `PORT` env var).

### 5. Open the UI

Open **[http://localhost:3000/app/](http://localhost:3000/app/)** in your browser.

The React app is pre-built and served by the Express server. No separate frontend server needed in production.

---

## Development: rebuilding the frontend

The React source lives in `frontend-src/`. The build output goes to `frontend/`, which the backend serves at `/app/`.

```bash
# Install frontend-src dependencies (first time only):
cd frontend-src
npm install

# Build (outputs to ../frontend/):
npm run build

# Development with hot reload (Vite dev server on :5173, proxies /api/* to :3000):
npm run dev
```

When using `npm run dev` in `frontend-src/`, open **http://localhost:5173** (not `/app/`).
The Vite dev server proxies all `/api/` requests to the backend at `:3000`.

---

## Backend scripts

Run all from the `backend/` directory.

| Script | Description |
|---|---|
| `npm run dev` | Start server with `node --watch` (auto-restart on changes) |
| `npm start` | Start server once |
| `npm test` | Run all tests (62 tests across 6 suites) |
| `npm run smoke-test [owner] [repo]` | Manual ingest smoke test (requires running server) |
| `npm run poll` | Run one polling cycle (standalone) |
| `npm run poll:watch` | Run polling in watch mode (repeating) |

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | ✓ | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ (or anon key) | Supabase service role key for backend writes |
| `SUPABASE_ANON_KEY` | ✓ (or service key) | Alternative if service role key not available |
| `GROQ_API_KEY` | ✓ | Groq API key |
| `GROQ_MODEL` | ✓ | Groq model ID (e.g. `qwen/qwen3.8-27b`) |
| `GITHUB_TOKEN` | optional | GitHub PAT — raises rate limit to 5,000/hr |
| `PORT` | optional | HTTP port (default: `3000`) |
| `FRONTEND_DIR` | optional | Override path to built frontend assets |
| `ENABLE_POLLING` | optional | Set `true` to enable background commit polling daemon |
| `POLL_INTERVAL_SECONDS` | optional | Polling interval in seconds (default: `60`) |
| `POLLING_SECRET` | optional | Enables `POST /api/polling/run` endpoint |

---

## Demo flow

1. **Job posting** — paste a real job or internship description. The backend LLM extracts structured requirements.
2. **Repository** — enter a GitHub owner/repo. The backend fetches files, chunks them (60-line chunks, 10-line overlap), embeds with `jinaai/jina-embeddings-v2-base-code`, and stores in Supabase pgvector.
3. **Assessment** — the backend retrieves the most similar code chunks per requirement, then asks the LLM for a verdict (`supported`, `partial`, `not_found`) with explanation and file citations.
4. **Results** — every requirement shows its verdict, explanation, confidence, and clickable links to the exact lines of code.

A missing signal means **"not demonstrated in the analyzed repository"** — never proof the candidate lacks the skill.

---

## Supabase schema

The project uses 8 tables with pgvector for vector search. The schema is applied to the remote Supabase project (`qnkosqbumadydglpbgmo`). Key tables:

- `job_postings` + `requirements` — posting and extracted requirements
- `repositories` + `repository_index_state` — tracked repos and polling state
- `code_chunks` — pgvector store (768-dim, `jinaai/jina-embeddings-v2-base-code`)
- `assessments` + `requirement_assessments` + `assessment_evidence` — assessment results and evidence citations

The vector search function `match_code_chunks(p_repository_id, p_embedding_model, p_query_embedding, p_match_count)` is deployed to the remote project.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js 22+ · Express 5 · ES modules |
| Database | Supabase Postgres + pgvector |
| Embeddings | `@huggingface/transformers` · `jinaai/jina-embeddings-v2-base-code` (768-dim) |
| LLM | Groq · `qwen/qwen3.8-27b` |
| GitHub API | Octokit |
| Frontend | React 19 · Vite 8 · Tailwind CSS v4 |

---

## Project structure

```
.
├── backend/
│   ├── src/
│   │   ├── index.js                  # Express server entry point
│   │   ├── controllers/              # HTTP layer
│   │   ├── services/                 # Business logic (extraction, chunking, embedding, assessment, polling)
│   │   ├── repositories/             # Supabase queries
│   │   └── routes/                   # Express routers
│   ├── package.json
│   └── .env.example
├── frontend/                         # Built React app (served at /app/)
│   ├── index.html
│   └── assets/
└── frontend-src/                     # React source (Vite + Tailwind)
    ├── src/
    │   ├── App.jsx
    │   ├── api.js
    │   ├── components/
    │   │   ├── JobPostingStep.jsx
    │   │   ├── RepositoryStep.jsx
    │   │   ├── AssessmentStep.jsx
    │   │   ├── AssessmentResults.jsx
    │   │   ├── FlowStatus.jsx
    │   │   └── ui.jsx
    │   └── index.css
    └── vite.config.js
```
