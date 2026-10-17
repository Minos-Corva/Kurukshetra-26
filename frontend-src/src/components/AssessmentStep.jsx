/**
 * AssessmentStep — Step 3: run an assessment via POST /api/assessments.
 *
 * Requires a posting ID and repository scope from prior steps. Tunable
 * matchCount and similarityThreshold. Shows loading, cached-result notice,
 * and on success scrolls to results.
 */
import { useState } from "react";
import { runAssessment, ApiError } from "../api.js";
import {
  Card, Notice, Spinner, FormField, ProgressLine,
  inputClass, btnPrimaryClass,
} from "./ui.jsx";

export function AssessmentStep({ postingId, repositoryId, owner, name, onDone, onError, onActive }) {
  const [matchCount, setMatchCount] = useState("5");
  const [simThreshold, setSimThreshold] = useState("0.5");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const ready = Boolean(postingId) && (Boolean(repositoryId) || (Boolean(owner) && Boolean(name)));

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!postingId) {
      setError({ title: "No job posting", message: "Save or select a job posting in step 1 first." });
      return;
    }
    if (!repositoryId && (!owner || !name)) {
      setError({ title: "No repository", message: "Index a repository in step 2 first." });
      return;
    }

    const mc = Math.min(50, Math.max(1, Math.trunc(Number(matchCount) || 5)));
    const st = Math.min(1, Math.max(0, Number(simThreshold) || 0.5));

    const body = {
      jobPostingId: postingId,
      matchCount: mc,
      similarityThreshold: st,
    };
    if (repositoryId) {
      body.repositoryId = repositoryId;
    } else {
      body.owner = owner;
      body.name = name;
    }

    setLoading(true);
    onActive();
    try {
      const data = await runAssessment(body);
      onDone(data);
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError({ title: "Unexpected error", message: err.message });
      setError(e);
      onError();
    } finally {
      setLoading(false);
    }
  }

  const hint = !postingId
    ? "Save or select a job posting in step 1 first."
    : !ready
    ? "Index a repository in step 2 first."
    : null;

  return (
    <Card id="step-assessment">
      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-7 h-7 rounded-lg bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-xs font-bold">3</div>
          <h2 className="text-lg font-bold text-white">Assess Requirements</h2>
        </div>
        <p className="text-sm text-slate-400">
          Retrieves code evidence per requirement and asks the backend model for a verdict.
          Repeating for the same commit reuses the stored assessment instead of re-running.
        </p>
      </div>

      {/* Status chips when locked in */}
      {ready && (
        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          <span className="bg-brand-500/10 border border-brand-500/20 text-brand-300 rounded-lg px-2.5 py-1">
            Posting: <code className="font-mono">{postingId?.slice(0, 8)}…</code>
          </span>
          {(repositoryId || (owner && name)) && (
            <span className="bg-violet-500/10 border border-violet-500/20 text-violet-300 rounded-lg px-2.5 py-1">
              Repo: {owner}/{name}
            </span>
          )}
        </div>
      )}

      {/* Form */}
      <form id="assess-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <FormField
            label="Evidence chunks per requirement"
            htmlFor="match-count"
            hint="1–50. More chunks = more evidence but slower."
          >
            <input
              id="match-count"
              type="number"
              min={1} max={50} step={1}
              value={matchCount}
              onChange={e => setMatchCount(e.target.value)}
              disabled={loading}
              className={inputClass}
            />
          </FormField>
          <FormField
            label="Similarity threshold (0–1)"
            htmlFor="similarity-threshold"
            hint="Chunks below this score are excluded."
          >
            <input
              id="similarity-threshold"
              type="number"
              min={0} max={1} step={0.05}
              value={simThreshold}
              onChange={e => setSimThreshold(e.target.value)}
              disabled={loading}
              className={inputClass}
            />
          </FormField>
        </div>

        <div className="flex items-start gap-3 flex-wrap">
          <button
            id="assess-submit"
            type="submit"
            disabled={loading || !ready}
            className={btnPrimaryClass + " bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/40"}
          >
            {loading && <Spinner size={16} />}
            {loading ? "Assessing requirements…" : "Assess requirements"}
          </button>

          {hint && (
            <p className="text-sm text-slate-400 flex items-center gap-1.5 mt-2">
              <span aria-hidden="true">⚠</span>
              {hint}
            </p>
          )}
        </div>

        <ProgressLine visible={loading} />
        {loading && (
          <p className="text-xs text-slate-400 animate-pulse">
            Retrieving code evidence and running model inference — this may take 10–30 seconds…
          </p>
        )}
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
    </Card>
  );
}
