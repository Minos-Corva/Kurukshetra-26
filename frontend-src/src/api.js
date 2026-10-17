/**
 * api.js — Thin API client for the W-PS-2 AI Career Coach backend.
 *
 * The browser never calls Groq or Supabase directly. All requests go through
 * the backend API. Secrets never live in the frontend.
 *
 * In development (Vite dev server on :5173), vite.config.js proxies /api/* to
 * http://localhost:3000, so no CORS is needed.
 * In production, the Express server serves this build at /app/ and the API is
 * same-origin, so again no CORS is needed.
 */

// Detect base URL: empty string means "use the origin that served the page"
const API_BASE = import.meta.env.DEV ? "" : "";

export class ApiError extends Error {
  constructor({ status, title, message, details }) {
    super(message || title || "Request failed");
    this.name = "ApiError";
    this.status = status ?? 0;
    this.title = title || "Request failed";
    this.details = Array.isArray(details) ? details : [];
  }
}

async function apiFetch(path, { method = "POST", body } = {}) {
  const url = `${API_BASE}${path}`;
  let response;

  try {
    response = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError({
      status: 0,
      title: "Network error",
      message: `Could not reach the backend at ${url}. Is the server running?`,
    });
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      title: (payload && payload.error) || `HTTP ${response.status}`,
      message:
        (payload && payload.message) ||
        "The backend rejected the request. Check your inputs and try again.",
      details: payload && payload.details,
    });
  }

  return payload;
}

/**
 * POST /api/job-postings
 * @param {{ sourceUrl: string, postingText: string }} params
 * @returns {{ posting: object, requirements: object[] }}
 */
export function submitJobPosting({ sourceUrl, postingText }) {
  return apiFetch("/api/job-postings", { body: { sourceUrl, postingText } });
}

/**
 * POST /api/repositories/ingest
 * @param {{ owner: string, name: string, branch?: string }} params
 * @returns {{ repository: object, indexedCommitSha: string, fileCount: number, chunkCount: number, status: string, message?: string }}
 */
export function ingestRepository({ owner, name, branch }) {
  const body = { owner, name };
  if (branch) body.branch = branch;
  return apiFetch("/api/repositories/ingest", { body });
}

/**
 * POST /api/assessments
 * @param {{ jobPostingId: string, repositoryId?: string, owner?: string, name?: string, matchCount?: number, similarityThreshold?: number }} params
 * @returns {{ assessment: object, created: boolean, requirementsCount: number, results: object[] }}
 */
export function runAssessment(params) {
  return apiFetch("/api/assessments", { body: params });
}
