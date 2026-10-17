/**
 * Runtime configuration for the W-PS-2 AI Career Coach assessment UI.
 *
 * This file is loaded by the browser, so it must never contain secrets.
 * No Supabase keys, Groq keys, or GitHub tokens belong here — the UI only
 * calls the backend API, which owns all provider credentials.
 *
 * API_BASE_URL:
 *   "" (default)  → call the API on the same origin that served this page.
 *                   This is what happens when the backend serves the UI at
 *                   http://localhost:3000/app/.
 *   "http://localhost:3000" → use this when the UI is hosted on a different
 *                   origin. Note: the backend does not enable CORS, so
 *                   cross-origin hosting requires serving the UI from the
 *                   backend (recommended) or adding CORS deliberately.
 */
window.__KURUKSHETRA_CONFIG__ = {
  API_BASE_URL: "",
};
