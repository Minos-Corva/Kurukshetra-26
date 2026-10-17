/**
 * Spinner — animated loading indicator.
 */
export function Spinner({ size = 20, className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`animate-spin-slow ${className}`}
      aria-hidden="true"
    >
      <circle
        cx="12" cy="12" r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="40 60"
        opacity="0.25"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * StatusBadge — pill showing supported / partial / not_found / uncertain.
 * Status is never conveyed by color alone: each badge has a symbol + label.
 */
const STATUS_META = {
  supported:  { label: "Supported",  symbol: "✓", colors: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30" },
  partial:    { label: "Partial",    symbol: "◐", colors: "text-amber-400 bg-amber-400/10 border-amber-400/30" },
  not_found:  { label: "Not found",  symbol: "✕", colors: "text-red-400 bg-red-400/10 border-red-400/30" },
  uncertain:  { label: "Uncertain",  symbol: "?", colors: "text-slate-400 bg-slate-400/10 border-slate-400/30" },
};

export function StatusBadge({ status }) {
  const meta = STATUS_META[status] ?? STATUS_META.uncertain;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-xs font-semibold whitespace-nowrap ${meta.colors}`}
    >
      <span aria-hidden="true">{meta.symbol}</span>
      {meta.label}
    </span>
  );
}

/**
 * Notice — error / info notice box.
 */
export function Notice({ kind = "error", title, children }) {
  const styles = {
    error: "bg-red-500/10 border-red-500/30 text-red-300",
    info:  "bg-brand-500/10 border-brand-500/30 text-brand-300",
    success: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
  };
  return (
    <div
      role="alert"
      className={`rounded-xl border px-4 py-3 text-sm ${styles[kind] || styles.error} animate-fade-in`}
    >
      {title && <strong className="block font-semibold mb-0.5">{title}</strong>}
      {children}
    </div>
  );
}

/**
 * Card — glass panel with optional title.
 */
export function Card({ children, className = "", id }) {
  return (
    <section
      id={id}
      className={`glass rounded-2xl p-6 ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * StepBadge — numbered circle for the step indicator.
 */
export function StepBadge({ number, state }) {
  // state: 'idle' | 'active' | 'done' | 'error'
  const base = "w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 border-2 transition-all duration-300";
  const variants = {
    idle:   "border-white/10 text-white/30",
    active: "border-brand-500 text-brand-400 animate-pulse-glow",
    done:   "border-emerald-500 bg-emerald-500 text-white",
    error:  "border-red-500 bg-red-500/20 text-red-400",
  };
  return (
    <div className={`${base} ${variants[state] || variants.idle}`}>
      {state === "done" ? "✓" : state === "error" ? "!" : number}
    </div>
  );
}

/**
 * CopyButton — copies a value to clipboard.
 */
export function CopyButton({ value, label }) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${label}`}
      className="ml-2 px-2 py-0.5 text-xs rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-colors"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// Import React for CopyButton
import React from "react";

/**
 * CodeChip — monospace value with optional copy button.
 */
export function CodeChip({ label, value }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      <span className="text-slate-400 font-medium">{label}:</span>
      <code className="font-mono text-xs bg-white/5 border border-white/10 rounded-md px-2 py-0.5 text-purple-300 break-all">
        {value}
      </code>
      {value && <CopyButton value={value} label={label} />}
    </div>
  );
}

/**
 * MetaChip — small labeled data pill.
 */
export function MetaChip({ label, value }) {
  return (
    <div className="flex items-center gap-1.5 bg-white/4 border border-white/8 rounded-lg px-3 py-1.5 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-100 font-medium">{value}</span>
    </div>
  );
}

/**
 * ProgressLine — animated busy line shown during API calls.
 */
export function ProgressLine({ visible }) {
  if (!visible) return null;
  return (
    <div className="h-0.5 rounded-full overflow-hidden bg-white/5 mt-3">
      <div className="h-full shimmer" />
    </div>
  );
}

/**
 * FormField — label + input wrapper.
 */
export function FormField({ label, htmlFor, hint, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-slate-200">
        {label}
      </label>
      {hint && <p className="text-xs text-slate-400 -mt-0.5">{hint}</p>}
      {children}
    </div>
  );
}

export const inputClass =
  "w-full bg-white/4 border border-white/10 rounded-xl px-3.5 py-2.5 text-slate-100 placeholder-slate-500 text-sm " +
  "focus:outline-none focus:border-brand-500/60 focus:bg-white/6 transition-colors";

export const btnPrimaryClass =
  "inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-sm " +
  "disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 shadow-lg shadow-brand-900/40";

export const btnSecondaryClass =
  "inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 font-medium text-sm " +
  "disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
