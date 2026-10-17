/**
 * App.jsx — W-PS-2 AI Career Coach Demo UI
 *
 * Three-step demo flow:
 *   1. Submit a job posting → extract requirements
 *   2. Index a GitHub repository → store embeddings
 *   3. Run an assessment → per-requirement evidence verdicts
 *
 * The browser never calls Groq, Supabase, or the GitHub API directly.
 * All requests go through the backend API (/api/*).
 */
import { useState, useRef, useCallback } from "react";
import { FlowStatus } from "./components/FlowStatus.jsx";
import { JobPostingStep } from "./components/JobPostingStep.jsx";
import { RepositoryStep } from "./components/RepositoryStep.jsx";
import { AssessmentStep } from "./components/AssessmentStep.jsx";
import { AssessmentResults } from "./components/AssessmentResults.jsx";

/* ------------------------------------------------------------------ */
/* State shape                                                          */
/* ------------------------------------------------------------------ */

const INITIAL_FLOW_STATES = { posting: "idle", repository: "idle", assessment: "idle" };
const INITIAL_FLOW_MSGS   = { posting: "",      repository: "",      assessment: "" };

function App() {
  // Step outputs
  const [postingId, setPostingId]       = useState(null);
  const [requirements, setRequirements] = useState([]);
  const [repositoryId, setRepositoryId] = useState(null);
  const [repoOwner, setRepoOwner]       = useState("");
  const [repoName, setRepoName]         = useState("");
  const [assessmentData, setAssessmentData] = useState(null);

  // Flow indicator
  const [flowStates, setFlowStates]     = useState(INITIAL_FLOW_STATES);
  const [flowMsgs, setFlowMsgs]         = useState(INITIAL_FLOW_MSGS);

  // Scroll ref for results
  const resultsRef = useRef(null);

  const setFlow = useCallback((step, state, msg) => {
    setFlowStates(s => ({ ...s, [step]: state }));
    setFlowMsgs(m => ({ ...m, [step]: msg }));
  }, []);

  /* ------------------------------------------------------------------ */
  /* Step handlers                                                        */
  /* ------------------------------------------------------------------ */

  function onPostingDone({ postingId: id, requirements: reqs }) {
    setPostingId(id);
    setRequirements(reqs);
    setFlow("posting", "done", `Saved — ${reqs.length} requirement${reqs.length !== 1 ? "s" : ""}`);
  }
  function onPostingActive() { setFlow("posting", "active", "Saving…"); }
  function onPostingError()  { setFlow("posting", "error",  "Failed"); }

  function onRepoDone({ repositoryId: id, owner, name, indexedCommitSha }) {
    setRepositoryId(id);
    if (owner) setRepoOwner(owner);
    if (name)  setRepoName(name);
    const sha = indexedCommitSha ? indexedCommitSha.slice(0, 10) : "?";
    setFlow("repository", "done", `Indexed @ ${sha}`);
  }
  function onRepoActive() { setFlow("repository", "active", "Indexing…"); }
  function onRepoError()  { setFlow("repository", "error",  "Failed"); }

  function onAssessDone(data) {
    setAssessmentData(data);
    const label = data.created === false ? "Loaded saved assessment" : "Assessment completed";
    setFlow("assessment", "done", label);
    // Scroll to results after a brief paint delay
    setTimeout(() => {
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  }
  function onAssessActive() { setFlow("assessment", "active", "Assessing…"); }
  function onAssessError()  { setFlow("assessment", "error",  "Failed"); }

  /* ------------------------------------------------------------------ */
  /* Render                                                               */
  /* ------------------------------------------------------------------ */

  return (
    <div className="min-h-screen flex flex-col">
      {/* Ambient background glows */}
      <div aria-hidden="true" className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="hero-glow w-[600px] h-[600px] bg-brand-600 -top-48 -left-24" />
        <div className="hero-glow w-[500px] h-[500px] bg-violet-700 top-1/3 -right-48" />
        <div className="hero-glow w-[400px] h-[400px] bg-emerald-700 bottom-0 left-1/3" />
      </div>

      {/* Header */}
      <header className="relative z-10 glass border-b border-white/8 px-4 sm:px-6 py-5">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-3">
            {/* Logo mark */}
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-violet-600 flex items-center justify-center flex-shrink-0 shadow-lg shadow-brand-900/50">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-black text-white leading-none tracking-tight">
                AI Career Coach
              </h1>
              <p className="text-xs text-slate-400 mt-0.5 leading-tight">
                W-PS-2 · Hackathon MVP
              </p>
            </div>
          </div>
          <p className="text-sm text-slate-400 mt-3 max-w-2xl leading-relaxed">
            Compare a real job posting with evidence in a GitHub repository.
            See exactly which requirements are demonstrated — with citations back to the code.
          </p>
        </div>
      </header>

      {/* Main */}
      <main id="main" tabIndex={-1} className="relative z-10 flex-1 max-w-4xl mx-auto w-full px-4 sm:px-6 py-8 space-y-5">
        {/* Skip link target */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:bg-brand-600 focus:text-white focus:px-4 focus:py-2 focus:rounded-lg"
        >
          Skip to main content
        </a>

        {/* Flow status */}
        <div
          role="status"
          aria-live="polite"
          aria-label="Demo flow progress"
        >
          <FlowStatus states={flowStates} messages={flowMsgs} />
        </div>

        {/* Step 1 */}
        <JobPostingStep
          onDone={onPostingDone}
          onError={onPostingError}
          onActive={onPostingActive}
        />

        {/* Step 2 */}
        <RepositoryStep
          onDone={onRepoDone}
          onError={onRepoError}
          onActive={onRepoActive}
        />

        {/* Step 3 */}
        <AssessmentStep
          postingId={postingId}
          repositoryId={repositoryId}
          owner={repoOwner}
          name={repoName}
          onDone={onAssessDone}
          onError={onAssessError}
          onActive={onAssessActive}
        />

        {/* Results */}
        <div ref={resultsRef}>
          {assessmentData && <AssessmentResults data={assessmentData} />}
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 glass border-t border-white/8 px-4 sm:px-6 py-4 mt-8">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>W-PS-2 AI Career Coach — hackathon MVP</span>
          <span>
            The browser never calls Groq, Supabase, or GitHub directly.
            All requests go through the backend API.
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
