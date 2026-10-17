/**
 * FlowStatus — shows which steps are done in the current session.
 */
import { StepBadge } from "./ui.jsx";

const STEPS = [
  { key: "posting",    label: "Job posting saved" },
  { key: "repository", label: "Repository indexed" },
  { key: "assessment", label: "Assessment complete" },
];

export function FlowStatus({ states, messages }) {
  return (
    <div className="flex flex-col sm:flex-row gap-3">
      {STEPS.map(({ key, label }, i) => {
        const state = states[key] || "idle";
        const msg = messages[key] || "";
        return (
          <div
            key={key}
            className={`flex items-center gap-3 flex-1 rounded-xl px-4 py-3 border transition-all duration-300 ${
              state === "done"
                ? "bg-emerald-500/5 border-emerald-500/20"
                : state === "active"
                ? "bg-brand-500/5 border-brand-500/20"
                : state === "error"
                ? "bg-red-500/5 border-red-500/20"
                : "bg-white/2 border-white/6"
            }`}
          >
            <StepBadge number={i + 1} state={state} />
            <div className="min-w-0">
              <p className={`text-sm font-semibold leading-tight ${
                state === "done" ? "text-emerald-300"
                : state === "active" ? "text-brand-300"
                : state === "error" ? "text-red-300"
                : "text-slate-300"
              }`}>
                {label}
              </p>
              {msg && (
                <p className={`text-xs mt-0.5 leading-tight ${
                  state === "done" ? "text-emerald-400/70"
                  : state === "active" ? "text-brand-400/70"
                  : state === "error" ? "text-red-400/70"
                  : "text-slate-400"
                }`}>
                  {msg}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
