/**
 * RepositoryStep — Step 2: index a GitHub repository via POST /api/repositories/ingest.
 *
 * Accepts owner, repo name, and optional branch. Shows commit SHA, file count,
 * and chunk count from the response. Re-runs are safe (idempotent).
 */
import { useState } from "react";
import { ingestRepository, ApiError } from "../api.js";
import {
  Card, Notice, Spinner, FormField, ProgressLine, CodeChip,
  inputClass, btnPrimaryClass,
} from "./ui.jsx";

function shortSha(sha) {
  if (!sha || typeof sha !== "string") return "unknown";
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

export function RepositoryStep({ onDone, onError, onActive }) {
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!owner.trim() || !name.trim()) {
      setError({ title: "Missing repository", message: "Enter both an owner and a repository name." });
      return;
    }

    setLoading(true);
    onActive();
    try {
      const data = await ingestRepository({ owner: owner.trim(), name: name.trim(), branch: branch.trim() || undefined });
      setResult(data);
      onDone({
        repositoryId: data.repository.id,
        owner: owner.trim(),
        name: name.trim(),
        repository: data.repository,
        indexedCommitSha: data.indexedCommitSha,
        fileCount: data.fileCount,
        chunkCount: data.chunkCount,
        status: data.status,
        message: data.message,
      });
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError({ title: "Unexpected error", message: err.message });
      setError(e);
      onError();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card id="step-repository">
      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-7 h-7 rounded-lg bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-400 text-xs font-bold">2</div>
          <h2 className="text-lg font-bold text-white">GitHub Repository</h2>
        </div>
        <p className="text-sm text-slate-400">
          Indexes the repository: fetches files, splits them into chunks, and stores vector
          embeddings. Safe to re-run — the backend skips work when the commit is unchanged.
          <span className="text-amber-400/80 ml-1">First run may take a minute.</span>
        </p>
      </div>

      {/* Form */}
      <form id="repo-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <FormField label="Owner" htmlFor="repo-owner">
            <input
              id="repo-owner"
              type="text"
              spellCheck={false}
              placeholder="expressjs"
              value={owner}
              onChange={e => setOwner(e.target.value)}
              disabled={loading}
              className={inputClass}
            />
          </FormField>
          <FormField label="Repository name" htmlFor="repo-name">
            <input
              id="repo-name"
              type="text"
              spellCheck={false}
              placeholder="express"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={loading}
              className={inputClass}
            />
          </FormField>
        </div>

        <FormField label="Branch (optional)" htmlFor="repo-branch" hint="Leave blank to use the repository's default branch.">
          <input
            id="repo-branch"
            type="text"
            spellCheck={false}
            placeholder="main"
            value={branch}
            onChange={e => setBranch(e.target.value)}
            disabled={loading}
            className={inputClass}
          />
        </FormField>

        <div className="flex items-center gap-3 flex-wrap">
          <button id="repo-submit" type="submit" disabled={loading} className={btnPrimaryClass + " bg-violet-600 hover:bg-violet-500 shadow-violet-900/40"}>
            {loading && <Spinner size={16} />}
            {loading ? "Indexing repository…" : "Index / refresh repository"}
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
        <div className="mt-5 pt-5 border-t border-white/8 space-y-4 animate-fade-in">
          <CodeChip label="Repository ID" value={result.repository.id} />

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Repo link */}
            {result.repository.html_url && (
              <a
                href={result.repository.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 bg-white/4 border border-white/10 rounded-xl px-4 py-3 hover:bg-white/7 transition-colors"
              >
                <svg className="w-4 h-4 text-slate-300 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                </svg>
                <div>
                  <p className="text-xs text-slate-400">Repository</p>
                  <p className="text-sm font-semibold text-slate-100">
                    {result.repository.full_name || `${owner}/${name}`}
                  </p>
                </div>
              </a>
            )}

            {/* Commit SHA */}
            <div className="bg-white/4 border border-white/10 rounded-xl px-4 py-3">
              <p className="text-xs text-slate-400 mb-0.5">Indexed commit</p>
              <code
                className="font-mono text-sm text-purple-300 font-semibold"
                title={result.indexedCommitSha || ""}
              >
                {shortSha(result.indexedCommitSha)}
              </code>
            </div>

            {/* File / chunk counts */}
            <div className="bg-white/4 border border-white/10 rounded-xl px-4 py-3">
              <p className="text-xs text-slate-400 mb-1">Index stats</p>
              <div className="flex gap-3 text-sm">
                <span>
                  <span className="font-bold text-slate-100">{result.fileCount ?? "?"}</span>
                  <span className="text-slate-400 ml-1">files</span>
                </span>
                <span className="text-slate-600">·</span>
                <span>
                  <span className="font-bold text-slate-100">{result.chunkCount ?? "?"}</span>
                  <span className="text-slate-400 ml-1">chunks</span>
                </span>
              </div>
            </div>
          </div>

          {/* Status */}
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
              result.status === "idle" ? "bg-emerald-400"
              : result.status === "running" ? "bg-amber-400 animate-pulse"
              : "bg-slate-400"
            }`} />
            <span className="text-sm text-slate-300 capitalize">{result.status || "indexed"}</span>
          </div>

          {result.message && (
            <Notice kind="info" title="Note">{result.message}</Notice>
          )}
        </div>
      )}
    </Card>
  );
}
