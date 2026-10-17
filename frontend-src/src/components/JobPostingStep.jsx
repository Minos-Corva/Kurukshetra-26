/**
 * JobPostingStep — Step 1: submit a job posting via POST /api/job-postings.
 *
 * Accepts a posting URL and pasted text. On success, stores the posting ID
 * and lists the extracted requirements. Also allows entering an existing UUID.
 */
import { useState } from "react";
import { submitJobPosting, ApiError } from "../api.js";
import {
  Card, Notice, Spinner, FormField, ProgressLine,
  inputClass, btnPrimaryClass, btnSecondaryClass,
} from "./ui.jsx";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function JobPostingStep({ onDone, onError, onActive }) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [postingText, setPostingText] = useState("");
  const [existingId, setExistingId] = useState("");
  const [showExisting, setShowExisting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    // Client-side validation
    if (!sourceUrl.trim()) {
      setError({ title: "Missing URL", message: "Enter the posting URL (https)." });
      return;
    }
    try {
      const u = new URL(sourceUrl.trim());
      if (u.protocol !== "https:") throw new Error("Must be https");
    } catch {
      setError({ title: "Invalid URL", message: "Enter a valid https:// URL for the posting." });
      return;
    }
    if (!postingText.trim()) {
      setError({ title: "Missing text", message: "Paste the full job description text before submitting." });
      return;
    }

    setLoading(true);
    onActive();
    try {
      const data = await submitJobPosting({ sourceUrl: sourceUrl.trim(), postingText });
      setResult(data);
      onDone({ postingId: data.posting.id, requirements: data.requirements });
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError({ title: "Unexpected error", message: err.message });
      setError(e);
      onError();
    } finally {
      setLoading(false);
    }
  }

  function handleUseExisting(e) {
    e.preventDefault();
    setError(null);
    if (!UUID_REGEX.test(existingId.trim())) {
      setError({ title: "Invalid UUID", message: "Enter a valid job posting UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)." });
      return;
    }
    onDone({ postingId: existingId.trim(), requirements: [] });
  }

  return (
    <Card id="step-posting">
      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-7 h-7 rounded-lg bg-brand-600/20 border border-brand-500/30 flex items-center justify-center text-brand-400 text-xs font-bold">1</div>
          <h2 className="text-lg font-bold text-white">Job Posting</h2>
        </div>
        <p className="text-sm text-slate-400">
          Submit a real job or internship posting. The backend LLM extracts structured requirements
          from it. There&apos;s no listing endpoint, so this page keeps the returned ID.
        </p>
      </div>

      {/* Form */}
      <form id="posting-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <FormField label="Posting URL (https)" htmlFor="source-url">
          <input
            id="source-url"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://example.com/jobs/software-engineer"
            value={sourceUrl}
            onChange={e => setSourceUrl(e.target.value)}
            disabled={loading}
            className={inputClass}
          />
        </FormField>

        <FormField
          label="Posting text"
          htmlFor="posting-text"
          hint="Paste the full job or internship description here."
        >
          <textarea
            id="posting-text"
            rows={8}
            placeholder="We are looking for a backend engineer with experience in Node.js, Postgres, REST APIs…"
            value={postingText}
            onChange={e => setPostingText(e.target.value)}
            disabled={loading}
            className={`${inputClass} font-mono resize-y min-h-36`}
          />
        </FormField>

        <div className="flex items-center gap-3 flex-wrap">
          <button id="posting-submit" type="submit" disabled={loading} className={btnPrimaryClass}>
            {loading && <Spinner size={16} />}
            {loading ? "Extracting requirements…" : "Extract requirements & save"}
          </button>
        </div>

        <ProgressLine visible={loading} />
      </form>

      {/* Error */}
      {error && (
        <div className="mt-4">
          <Notice kind="error" title={error.title}>
            {error.message}
            {error.details && error.details.length > 0 && (
              <ul className="mt-1 list-disc list-inside">
                {error.details.map((d, i) => <li key={i}>{String(d)}</li>)}
              </ul>
            )}
          </Notice>
        </div>
      )}

      {/* Success result */}
      {result && (
        <div className="mt-5 pt-5 border-t border-white/8 space-y-3 animate-fade-in">
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <span className="text-slate-400">Posting ID:</span>
            <code className="font-mono text-xs bg-white/5 border border-white/10 rounded px-2 py-0.5 text-purple-300 break-all">
              {result.posting.id}
            </code>
          </div>

          {result.requirements && result.requirements.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-slate-200 mb-2">
                {result.requirements.length} requirement{result.requirements.length !== 1 ? "s" : ""} extracted
              </p>
              <ul className="space-y-1.5">
                {result.requirements.map((req, i) => (
                  <li
                    key={req.id || i}
                    className="flex items-start gap-2 text-sm bg-white/3 border border-white/7 rounded-lg px-3 py-2"
                  >
                    <span className="text-brand-400 font-bold mt-px">{i + 1}.</span>
                    <div>
                      <span className="font-semibold text-slate-100">{req.skill || req.requirement_key}</span>
                      {req.description && (
                        <span className="text-slate-400 ml-2">— {req.description}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Existing posting */}
      <div className="mt-5 pt-4 border-t border-white/6">
        <button
          type="button"
          onClick={() => setShowExisting(v => !v)}
          className="text-sm text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-1.5"
          aria-expanded={showExisting}
        >
          <span>{showExisting ? "▾" : "▸"}</span>
          Use an existing posting ID
        </button>

        {showExisting && (
          <form id="existing-posting-form" onSubmit={handleUseExisting} className="mt-3 flex flex-wrap gap-2 items-end animate-fade-in">
            <div className="flex-1 min-w-48">
              <FormField label="Job posting UUID" htmlFor="existing-posting-id">
                <input
                  id="existing-posting-id"
                  type="text"
                  spellCheck={false}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={existingId}
                  onChange={e => setExistingId(e.target.value)}
                  className={inputClass}
                />
              </FormField>
            </div>
            <button id="use-posting-btn" type="submit" className={btnSecondaryClass}>
              Use this ID
            </button>
          </form>
        )}
      </div>
    </Card>
  );
}
