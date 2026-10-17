/**
 * AssessmentResults — renders the full assessment: summary + per-requirement cards.
 *
 * Evidence items include clickable source links (file path, line range).
 * Status is shown with a symbol + label — never color alone.
 * "not_found" includes an explicit disclaimer that this is not a claim about the candidate.
 */
import { useState } from "react";
import { StatusBadge, CodeChip, Notice } from "./ui.jsx";

function shortSha(sha) {
  if (!sha || typeof sha !== "string") return "unknown";
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

function formatLines(start, end) {
  if (start == null && end == null) return null;
  if (start != null && end != null) return start === end ? String(start) : `${start}-${end}`;
  return String(start ?? end);
}

function EvidenceItem({ item }) {
  const lineRange = item.lineRange || formatLines(item.startLine, item.endLine);
  const location = lineRange ? `${item.filePath}:${lineRange}` : (item.filePath || "source file");

  return (
    <li className="bg-white/3 border border-white/8 rounded-xl p-3">
      <div className="flex flex-wrap items-start gap-2">
        {item.sourceUrl ? (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-brand-400 hover:text-brand-300 underline underline-offset-2 decoration-brand-400/40 hover:decoration-brand-300 transition-colors break-all"
          >
            {location}
          </a>
        ) : (
          <code className="font-mono text-xs text-slate-300 break-all">{location}</code>
        )}

        {typeof item.similarity === "number" && (
          <span className="ml-auto flex-shrink-0 text-xs text-slate-400 bg-white/4 border border-white/8 rounded-md px-1.5 py-0.5">
            sim {item.similarity.toFixed(3)}
          </span>
        )}
      </div>
    </li>
  );
}

function RequirementCard({ result, index }) {
  const [expanded, setExpanded] = useState(true);
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];

  const borderColor =
    result.status === "supported" ? "border-l-emerald-500"
    : result.status === "partial" ? "border-l-amber-500"
    : "border-l-red-500/60";

  return (
    <article
      data-status={result.status}
      className={`glass rounded-2xl overflow-hidden border-l-4 ${borderColor} animate-fade-in`}
      style={{ animationDelay: `${index * 40}ms` }}
    >
      {/* Requirement header */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full text-left flex items-start justify-between gap-3 px-5 py-4 hover:bg-white/2 transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <span className="text-slate-400 text-sm font-bold mt-0.5 flex-shrink-0">{index + 1}.</span>
          <div className="min-w-0">
            <h3 className="font-bold text-slate-100 leading-snug">
              {result.skill || result.requirementKey || "Requirement"}
            </h3>
            {result.description && (
              <p className="text-sm text-slate-400 mt-0.5 leading-relaxed">{result.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
          <StatusBadge status={result.status} />
          <span className="text-slate-500 text-xs">{expanded ? "▾" : "▸"}</span>
        </div>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="px-5 pb-5 border-t border-white/6 space-y-4">
          {/* Explanation + confidence */}
          <div className="mt-4 space-y-2">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-slate-400 font-semibold">Explanation</dt>
              <dd className="text-slate-200">{result.explanation || "No explanation provided."}</dd>

              {typeof result.confidence === "number" && (
                <>
                  <dt className="text-slate-400 font-semibold">Confidence</dt>
                  <dd className="flex items-center gap-2">
                    <div className="flex-1 max-w-32 h-1.5 bg-white/8 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          result.status === "supported" ? "bg-emerald-400"
                          : result.status === "partial" ? "bg-amber-400"
                          : "bg-red-400/60"
                        }`}
                        style={{ width: `${Math.round(result.confidence * 100)}%` }}
                      />
                    </div>
                    <span className="text-slate-300 text-xs">{(result.confidence * 100).toFixed(0)}%</span>
                  </dd>
                </>
              )}
            </dl>
          </div>

          {/* Not-found disclaimer */}
          {result.status === "not_found" && (
            <Notice kind="info" title="Not demonstrated">
              This requirement was not demonstrated in the analyzed repository. This is{" "}
              <strong>not</strong> a claim that the candidate lacks the skill.
            </Notice>
          )}

          {/* Evidence */}
          <div>
            <h4 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
              Evidence
              <span className="text-xs font-normal text-slate-500 bg-white/5 rounded-full px-2 py-0.5">
                {evidence.length}
              </span>
            </h4>

            {evidence.length === 0 ? (
              <p className="text-sm text-slate-500 border border-dashed border-white/10 rounded-xl px-4 py-3">
                No evidence was retrieved for this requirement in the analyzed repository.
              </p>
            ) : (
              <ul className="space-y-2">
                {evidence.map((item, i) => (
                  <EvidenceItem key={item.evidenceId || item.chunkId || i} item={item} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

export function AssessmentResults({ data }) {
  if (!data) return null;

  const results = Array.isArray(data.results) ? data.results : [];
  const assessment = data.assessment || {};
  const repo = assessment.repository || {};

  const counts = { supported: 0, partial: 0, not_found: 0, uncertain: 0 };
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  }

  return (
    <section id="results-section" aria-labelledby="results-heading" className="space-y-5">
      {/* Section header */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-white/8" />
        <h2 id="results-heading" className="text-xl font-bold text-white px-2">Assessment Results</h2>
        <div className="h-px flex-1 bg-white/8" />
      </div>

      {/* Summary bar */}
      <div className="glass rounded-2xl p-5">
        {data.created === false && (
          <Notice kind="info" title="Reused saved assessment">
            A previous assessment for this commit SHA already existed. Shown below is that result.
          </Notice>
        )}

        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <CodeChip label="Assessment ID" value={assessment.id || "unknown"} />
        </div>

        <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <SummaryTile label="Total" value={results.length} color="text-slate-100" />
          <SummaryTile label="Supported" value={counts.supported} color="text-emerald-400" symbol="✓" />
          <SummaryTile label="Partial" value={counts.partial} color="text-amber-400" symbol="◐" />
          <SummaryTile label="Not found" value={counts.not_found} color="text-red-400" symbol="✕" />
        </div>

        <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-400">
          {assessment.modelName && (
            <span>Model: <code className="font-mono text-slate-300">{assessment.modelName}</code></span>
          )}
          {(repo.indexedCommitSha || assessment.commitSha) && (
            <span>
              Commit: <code className="font-mono text-purple-300" title={repo.indexedCommitSha || assessment.commitSha}>
                {shortSha(repo.indexedCommitSha || assessment.commitSha)}
              </code>
            </span>
          )}
          {(repo.full_name || repo.fullName) && (
            <span>
              Repo:{" "}
              {repo.html_url || repo.htmlUrl ? (
                <a
                  href={repo.html_url || repo.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-400 hover:text-brand-300 underline"
                >
                  {repo.full_name || repo.fullName}
                </a>
              ) : (
                <span className="text-slate-300">{repo.full_name || repo.fullName}</span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Per-requirement cards */}
      {results.length === 0 ? (
        <p className="text-slate-400 text-center py-8">The assessment returned no requirements.</p>
      ) : (
        <div className="space-y-3">
          {results.map((r, i) => (
            <RequirementCard key={r.requirementId || i} result={r} index={i} />
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="glass rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-slate-300 mb-3">How to read the statuses</h3>
        <ul className="space-y-2 text-sm">
          <li className="flex items-start gap-2">
            <span className="text-emerald-400 font-bold mt-px">✓</span>
            <span><strong className="text-slate-200">Supported</strong> — the retrieved code clearly demonstrates the requirement.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-amber-400 font-bold mt-px">◐</span>
            <span><strong className="text-slate-200">Partial</strong> — the retrieved code demonstrates only part of the requirement.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-red-400 font-bold mt-px">✕</span>
            <span>
              <strong className="text-slate-200">Not found</strong> — <em>not demonstrated in the analyzed repository.</em>{" "}
              This is <strong className="text-red-300">not</strong> proof that the candidate lacks the skill.
            </span>
          </li>
        </ul>
        <p className="text-xs text-slate-500 mt-3">
          The browser never decides these statuses. They are shown exactly as the backend returned them.
        </p>
      </div>
    </section>
  );
}

function SummaryTile({ label, value, color, symbol }) {
  return (
    <div className="bg-white/3 border border-white/8 rounded-xl px-4 py-3 flex items-center gap-3">
      {symbol && <span className={`text-xl font-bold ${color}`} aria-hidden="true">{symbol}</span>}
      <div>
        <p className={`text-2xl font-black ${color}`}>{value}</p>
        <p className="text-xs text-slate-400">{label}</p>
      </div>
    </div>
  );
}
