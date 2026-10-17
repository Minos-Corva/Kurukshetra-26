/**
 * app.js — Feature 8: Assessment display UI.
 *
 * Flow: submit a job posting → index a GitHub repository → assess requirements.
 * Everything is driven by the backend's real API contract:
 *   POST /api/job-postings
 *   POST /api/repositories/ingest
 *   POST /api/assessments
 *
 * The browser never decides a status and never calls Groq or vector search
 * directly — it displays exactly what the backend returns.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_META = {
  supported: { label: "Supported", symbol: "✓", cls: "badge--supported" },
  partial: { label: "Partial", symbol: "◐", cls: "badge--partial" },
  not_found: { label: "Not found", symbol: "✕", cls: "badge--not-found" },
  uncertain: { label: "Uncertain", symbol: "?", cls: "badge--uncertain" },
};

const config = readConfig();

const state = {
  jobPostingId: null,
  postingRequirements: [],
  repositoryId: null,
  repository: null,
  assessment: null,
};

const busy = { posting: false, repository: false, assessment: false };

/* ------------------------------------------------------------------ */
/* DOM references                                                      */
/* ------------------------------------------------------------------ */

const el = {
  configWarning: document.getElementById("config-warning"),

  postingForm: document.getElementById("posting-form"),
  sourceUrl: document.getElementById("source-url"),
  postingText: document.getElementById("posting-text"),
  postingSubmit: document.getElementById("posting-submit"),
  postingProgress: document.getElementById("posting-progress"),
  postingError: document.getElementById("posting-error"),
  existingPostingId: document.getElementById("existing-posting-id"),
  usePostingBtn: document.getElementById("use-posting-btn"),
  postingResult: document.getElementById("posting-result"),

  repoForm: document.getElementById("repo-form"),
  repoOwner: document.getElementById("repo-owner"),
  repoName: document.getElementById("repo-name"),
  repoBranch: document.getElementById("repo-branch"),
  repoSubmit: document.getElementById("repo-submit"),
  repoProgress: document.getElementById("repo-progress"),
  repoError: document.getElementById("repo-error"),
  repoResult: document.getElementById("repo-result"),

  assessForm: document.getElementById("assess-form"),
  matchCount: document.getElementById("match-count"),
  similarityThreshold: document.getElementById("similarity-threshold"),
  assessSubmit: document.getElementById("assess-submit"),
  assessProgress: document.getElementById("assess-progress"),
  assessError: document.getElementById("assess-error"),
  assessHint: document.querySelector("[data-assess-hint]"),

  resultsSection: document.getElementById("results-section"),
  resultsSummary: document.getElementById("results-summary"),
  resultsList: document.getElementById("results-list"),
};

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function readConfig() {
  const raw = window.__KURUKSHETRA_CONFIG__;
  if (!raw || typeof raw !== "object") {
    return { apiBaseUrl: "", configFileLoaded: false };
  }
  const value = typeof raw.API_BASE_URL === "string" ? raw.API_BASE_URL.trim() : "";
  return { apiBaseUrl: value.replace(/\/+$/, ""), configFileLoaded: true };
}

function checkConfig() {
  const warnings = [];

  if (!config.configFileLoaded) {
    warnings.push(
      "frontend/config.js was not found, so the API base URL is unknown. Calls will go to this page's origin."
    );
  }

  if (!config.apiBaseUrl && window.location.protocol === "file:") {
    warnings.push(
      "This page was opened from the file system, so it cannot call the API. Start the backend and open http://localhost:3000/app/ instead (or set API_BASE_URL in frontend/config.js)."
    );
  }

  if (warnings.length > 0) {
    el.configWarning.textContent = warnings.join(" ");
    el.configWarning.hidden = false;
  }
}

/* ------------------------------------------------------------------ */
/* API client                                                          */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor({ status, title, message, details }) {
    super(message || title || "Request failed");
    this.name = "ApiError";
    this.status = status ?? 0;
    this.title = title || "Request failed";
    this.details = Array.isArray(details) ? details : [];
  }
}

async function apiFetch(path, { method = "POST", body } = {}) {
  const url = `${config.apiBaseUrl}${path}`;
  let response;

  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError({
      status: 0,
      title: "Network error",
      message: `Could not reach the backend at ${url}. Check that the server is running.`,
    });
  }

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    // Surface only the backend's own sanitized fields — never raw response text,
    // which could contain a stack trace or internal detail.
    throw new ApiError({
      status: response.status,
      title: (payload && payload.error) || `Request failed (HTTP ${response.status})`,
      message:
        (payload && payload.message) ||
        "The backend rejected the request. Review the inputs and try again.",
      details: payload && payload.details,
    });
  }

  return payload;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function showError(node, error) {
  node.textContent = "";

  const title = document.createElement("span");
  title.className = "notice__title";
  title.textContent = error.title || "Request failed";
  node.append(title);

  if (error.message) {
    node.append(document.createTextNode(error.message));
  }

  if (error.details && error.details.length > 0) {
    const list = document.createElement("ul");
    for (const detail of error.details) {
      const item = document.createElement("li");
      item.textContent = String(detail);
      list.append(item);
    }
    node.append(list);
  }

  node.hidden = false;
}

function clearError(node) {
  node.hidden = true;
  node.textContent = "";
}

function setProgress(node, message) {
  node.textContent = message || "";
  if (message) {
    node.dataset.busy = "true";
  } else {
    delete node.dataset.busy;
  }
}

function setFlow(step, status, text) {
  const item = document.querySelector(`.flow__item[data-step="${step}"]`);
  const stateNode = document.querySelector(`[data-flow-state="${step}"]`);
  if (item) item.dataset.state = status;
  if (stateNode) stateNode.textContent = text;
}

function shortSha(sha) {
  if (typeof sha !== "string" || sha.length === 0) return "unknown";
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

function chip(label, contentNode) {
  const wrap = document.createElement("p");
  wrap.className = "summary__item";
  const strong = document.createElement("strong");
  strong.textContent = `${label}: `;
  wrap.append(strong);
  if (typeof contentNode === "string") {
    wrap.append(document.createTextNode(contentNode));
  } else if (contentNode) {
    wrap.append(contentNode);
  }
  return wrap;
}

function codeChip(label, value) {
  const code = document.createElement("code");
  code.textContent = value;
  const wrap = chip(label, code);
  if (value) wrap.append(copyButton(value, label));
  return wrap;
}

function copyButton(value, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.style.padding = "2px 10px";
  button.style.fontSize = "0.8rem";
  button.textContent = "Copy";
  button.setAttribute("aria-label", `Copy ${label}`);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1500);
    } catch {
      button.textContent = "Copy failed";
    }
  });
  return button;
}

function linkNode(href, text) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = text;
  return anchor;
}

function parseNumberInput(input, fallback) {
  const raw = input.value.trim();
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/* ------------------------------------------------------------------ */
/* Step 1: job posting                                                 */
/* ------------------------------------------------------------------ */

function onPostingSubmit(event) {
  event.preventDefault();
  clearError(el.postingError);

  const sourceUrl = el.sourceUrl.value.trim();
  const postingText = el.postingText.value;

  if (!sourceUrl) {
    showError(el.postingError, new ApiError({ title: "Missing URL", message: "Enter the posting's https URL." }));
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    showError(el.postingError, new ApiError({ title: "Invalid URL", message: "The posting URL is not a valid URL." }));
    return;
  }

  if (parsedUrl.protocol !== "https:") {
    showError(
      el.postingError,
      new ApiError({ title: "Invalid URL", message: "The posting URL must start with https://." })
    );
    return;
  }

  if (!postingText.trim()) {
    showError(
      el.postingError,
      new ApiError({ title: "Missing text", message: "Paste the posting text before submitting." })
    );
    return;
  }

  busy.posting = true;
  el.postingSubmit.disabled = true;
  setProgress(el.postingProgress, "Extracting requirements…");
  setFlow("posting", "active", "Saving…");

  apiFetch("/api/job-postings", { body: { sourceUrl, postingText } })
    .then((data) => {
      state.jobPostingId = data.posting.id;
      state.postingRequirements = Array.isArray(data.requirements) ? data.requirements : [];
      renderPostingResult({ id: data.posting.id, requirements: state.postingRequirements });
      setFlow("posting", "done", `Saved — ${state.postingRequirements.length} requirement(s)`);
    })
    .catch((error) => {
      showError(el.postingError, error);
      setFlow("posting", "error", "Failed");
    })
    .finally(() => {
      busy.posting = false;
      el.postingSubmit.disabled = false;
      setProgress(el.postingProgress, "");
      updateAssessState();
    });
}

function onUsePosting() {
  clearError(el.postingError);

  const id = el.existingPostingId.value.trim();
  if (!UUID_REGEX.test(id)) {
    showError(
      el.postingError,
      new ApiError({
        title: "Invalid posting ID",
        message: "Enter a valid job posting UUID, for example 1579df0a-cde5-40fc-b802-de46d2c27f08.",
      })
    );
    return;
  }

  state.jobPostingId = id;
  state.postingRequirements = [];
  renderPostingResult({ id, requirements: [] });
  setFlow("posting", "done", "Selected (existing posting)");
  updateAssessState();
}

function renderPostingResult({ id, requirements }) {
  el.postingResult.textContent = "";
  el.postingResult.hidden = false;
  el.postingResult.append(codeChip("Posting ID", id));

  if (requirements.length === 0) {
    const note = document.createElement("p");
    note.className = "card__hint";
    note.textContent =
      "Using an existing posting ID: the requirement list is not available here because the API has no read endpoint for postings.";
    el.postingResult.append(note);
    return;
  }

  el.postingResult.append(chip("Requirements", `${requirements.length} extracted`));

  const list = document.createElement("ul");
  list.className = "requirement-list";
  for (const requirement of requirements) {
    const item = document.createElement("li");
    const skill = requirement.skill || requirement.requirement_key || "Requirement";
    item.textContent = requirement.description ? `${skill} — ${requirement.description}` : skill;
    list.append(item);
  }
  el.postingResult.append(list);
}

/* ------------------------------------------------------------------ */
/* Step 2: repository                                                  */
/* ------------------------------------------------------------------ */

function onRepoSubmit(event) {
  event.preventDefault();
  clearError(el.repoError);

  const owner = el.repoOwner.value.trim();
  const name = el.repoName.value.trim();
  const branch = el.repoBranch.value.trim();

  if (!owner || !name) {
    showError(
      el.repoError,
      new ApiError({ title: "Missing repository", message: "Enter both an owner and a repository name." })
    );
    return;
  }

  busy.repository = true;
  el.repoSubmit.disabled = true;
  setProgress(el.repoProgress, "Indexing repository — the first run can take a while…");
  setFlow("repository", "active", "Indexing…");

  const body = { owner, name };
  if (branch) body.branch = branch;

  apiFetch("/api/repositories/ingest", { body })
    .then((data) => {
      state.repositoryId = data.repository.id;
      state.repository = {
        id: data.repository.id,
        fullName: data.repository.full_name || `${owner}/${name}`,
        htmlUrl: data.repository.html_url,
        indexedCommitSha: data.indexedCommitSha,
        fileCount: data.fileCount,
        chunkCount: data.chunkCount,
        status: data.status,
        message: data.message,
      };
      renderRepoResult(state.repository);
      setFlow("repository", "done", `Indexed @ ${shortSha(data.indexedCommitSha)}`);
    })
    .catch((error) => {
      showError(el.repoError, error);
      setFlow("repository", "error", "Failed");
    })
    .finally(() => {
      busy.repository = false;
      el.repoSubmit.disabled = false;
      setProgress(el.repoProgress, "");
      updateAssessState();
    });
}

function renderRepoResult(repository) {
  el.repoResult.textContent = "";
  el.repoResult.hidden = false;
  el.repoResult.append(codeChip("Repository ID", repository.id));

  const meta = document.createElement("div");
  meta.className = "summary";
  meta.append(chip("Repository", repository.fullName));

  const shaCode = document.createElement("code");
  shaCode.textContent = shortSha(repository.indexedCommitSha);
  shaCode.title = repository.indexedCommitSha || "";
  meta.append(chip("Commit", shaCode));

  meta.append(
    chip(
      "Index state",
      `${repository.status ?? "unknown"} · files: ${repository.fileCount ?? "?"} · chunks: ${
        repository.chunkCount ?? "?"
      }`
    )
  );

  if (repository.htmlUrl) {
    meta.append(chip("GitHub", linkNode(repository.htmlUrl, repository.htmlUrl)));
  }
  el.repoResult.append(meta);

  if (repository.message) {
    const note = document.createElement("p");
    note.className = "card__hint";
    note.textContent = repository.message;
    el.repoResult.append(note);
  }
}

/* ------------------------------------------------------------------ */
/* Step 3: assessment                                                  */
/* ------------------------------------------------------------------ */

function getRepositoryScope() {
  if (state.repositoryId) return { repositoryId: state.repositoryId };
  const owner = el.repoOwner.value.trim();
  const name = el.repoName.value.trim();
  if (owner && name) return { owner, name };
  return null;
}

function updateAssessState() {
  const hasPosting = Boolean(state.jobPostingId);
  const scope = getRepositoryScope();
  const ready = hasPosting && Boolean(scope) && !busy.assessment;

  el.assessSubmit.disabled = !ready;

  if (ready) {
    el.assessHint.hidden = true;
    el.assessHint.textContent = "";
  } else {
    el.assessHint.hidden = false;
    el.assessHint.textContent = !hasPosting
      ? "Save or select a job posting first."
      : "Index a repository, or enter an owner and name above.";
  }
}

function onAssessSubmit(event) {
  event.preventDefault();
  clearError(el.assessError);

  if (!state.jobPostingId) {
    showError(
      el.assessError,
      new ApiError({ title: "No job posting", message: "Save or select a job posting first." })
    );
    return;
  }

  const scope = getRepositoryScope();
  if (!scope) {
    showError(
      el.assessError,
      new ApiError({ title: "No repository", message: "Index a repository, or enter an owner and name." })
    );
    return;
  }

  const matchCount = Math.min(50, Math.max(1, Math.trunc(parseNumberInput(el.matchCount, 5))));
  const similarityThreshold = Math.min(1, Math.max(0, parseNumberInput(el.similarityThreshold, 0.5)));
  const body = { jobPostingId: state.jobPostingId, ...scope, matchCount, similarityThreshold };

  busy.assessment = true;
  el.assessSubmit.disabled = true;
  setProgress(el.assessProgress, "Retrieving evidence and assessing each requirement…");
  setFlow("assessment", "active", "Assessing…");

  apiFetch("/api/assessments", { body })
    .then((data) => {
      state.assessment = data;
      renderResults(data);
      setFlow(
        "assessment",
        "done",
        data.created === false ? "Loaded saved assessment" : "Assessment completed"
      );
    })
    .catch((error) => {
      showError(el.assessError, error);
      setFlow("assessment", "error", "Failed");
    })
    .finally(() => {
      busy.assessment = false;
      setProgress(el.assessProgress, "");
      updateAssessState();
    });
}

/* ------------------------------------------------------------------ */
/* Results rendering                                                   */
/* ------------------------------------------------------------------ */

function statusBadge(status) {
  const meta = STATUS_META[status];
  const badge = document.createElement("span");
  badge.className = `badge ${meta ? meta.cls : "badge--uncertain"}`;
  badge.textContent = meta ? `${meta.symbol} ${meta.label}` : `${status}`;
  return badge;
}

function renderResults(data) {
  const results = Array.isArray(data.results) ? data.results : [];
  const assessment = data.assessment || {};
  const repository = assessment.repository || {};

  const counts = { supported: 0, partial: 0, not_found: 0, uncertain: 0 };
  for (const result of results) {
    counts[result.status] = (counts[result.status] || 0) + 1;
  }

  el.resultsSummary.textContent = "";
  el.resultsSummary.append(codeChip("Assessment ID", assessment.id || "unknown"));
  el.resultsSummary.append(
    chip("Run", data.created === false ? "reused saved assessment" : "new assessment")
  );
  el.resultsSummary.append(chip("Model", assessment.modelName || "unknown"));

  const shaCode = document.createElement("code");
  shaCode.textContent = shortSha(repository.indexedCommitSha);
  shaCode.title = repository.indexedCommitSha || "";
  el.resultsSummary.append(chip("Commit", shaCode));

  if (repository.fullName || repository.htmlUrl) {
    const name = repository.fullName || repository.owner || "repository";
    el.resultsSummary.append(
      chip("Repository", repository.htmlUrl ? linkNode(repository.htmlUrl, name) : name)
    );
  }

  el.resultsSummary.append(chip("Requirements", String(results.length)));
  el.resultsSummary.append(chip("Supported", String(counts.supported)));
  el.resultsSummary.append(chip("Partial", String(counts.partial)));
  el.resultsSummary.append(chip("Not found", String(counts.not_found)));
  if (counts.uncertain > 0) {
    el.resultsSummary.append(chip("Uncertain", String(counts.uncertain)));
  }

  el.resultsList.textContent = "";
  if (results.length === 0) {
    const empty = document.createElement("p");
    empty.className = "requirement__empty";
    empty.textContent = "The assessment returned no requirements.";
    el.resultsList.append(empty);
  }

  results.forEach((result, index) => {
    el.resultsList.append(renderRequirement(result, index));
  });

  el.resultsSection.hidden = false;
  el.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderRequirement(result, index) {
  const article = document.createElement("article");
  article.className = "requirement";
  article.dataset.status = result.status || "uncertain";

  const head = document.createElement("div");
  head.className = "requirement__head";

  const heading = document.createElement("h3");
  heading.className = "requirement__skill";
  heading.textContent = `${index + 1}. ${result.skill || result.requirementKey || "Requirement"}`;
  head.append(heading);
  head.append(statusBadge(result.status));
  article.append(head);

  if (result.description) {
    const text = document.createElement("p");
    text.className = "requirement__text";
    text.textContent = result.description;
    article.append(text);
  }

  const metaList = document.createElement("dl");
  metaList.className = "requirement__meta";

  const dtExplanation = document.createElement("dt");
  dtExplanation.textContent = "Explanation";
  const ddExplanation = document.createElement("dd");
  ddExplanation.textContent = result.explanation || "No explanation provided.";
  metaList.append(dtExplanation, ddExplanation);

  if (typeof result.confidence === "number") {
    const dtConfidence = document.createElement("dt");
    dtConfidence.textContent = "Confidence";
    const ddConfidence = document.createElement("dd");
    ddConfidence.textContent = result.confidence.toFixed(2);
    metaList.append(dtConfidence, ddConfidence);
  }
  article.append(metaList);

  if (result.status === "not_found") {
    const note = document.createElement("p");
    note.className = "card__hint";
    note.textContent =
      "Not demonstrated in the analyzed repository. This is not a claim that the candidate lacks the skill.";
    article.append(note);
  }

  article.append(renderEvidence(result));
  return article;
}

function renderEvidence(result) {
  const evidenceWrap = document.createElement("div");
  evidenceWrap.className = "evidence";

  const evidence = Array.isArray(result.evidence) ? result.evidence : [];

  const heading = document.createElement("h4");
  heading.textContent = `Evidence (${evidence.length})`;
  evidenceWrap.append(heading);

  if (evidence.length === 0) {
    const empty = document.createElement("p");
    empty.className = "requirement__empty";
    empty.textContent = "No evidence was retrieved for this requirement in the analyzed repository.";
    evidenceWrap.append(empty);
    return evidenceWrap;
  }

  const list = document.createElement("ul");
  for (const item of evidence) {
    list.append(renderEvidenceItem(item));
  }
  evidenceWrap.append(list);
  return evidenceWrap;
}

function renderEvidenceItem(item) {
  const entry = document.createElement("li");

  const lineRange = item.lineRange || formatLines(item.startLine, item.endLine);
  const location = lineRange ? `${item.filePath}:${lineRange}` : item.filePath || "source file";

  if (item.sourceUrl) {
    entry.append(linkNode(item.sourceUrl, location));
  } else {
    const code = document.createElement("code");
    code.textContent = location;
    entry.append(code);
  }

  const details = [];
  if (typeof item.similarity === "number") {
    details.push(`similarity ${item.similarity.toFixed(3)}`);
  }
  if (details.length > 0) {
    const meta = document.createElement("span");
    meta.className = "progress";
    meta.style.marginLeft = "8px";
    meta.textContent = `(${details.join(", ")})`;
    entry.append(meta);
  }

  return entry;
}

function formatLines(startLine, endLine) {
  if (startLine == null && endLine == null) return null;
  if (startLine != null && endLine != null) {
    return startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
  }
  return String(startLine ?? endLine);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

el.postingForm.addEventListener("submit", onPostingSubmit);
el.usePostingBtn.addEventListener("click", onUsePosting);
el.repoForm.addEventListener("submit", onRepoSubmit);
el.assessForm.addEventListener("submit", onAssessSubmit);

for (const input of [el.repoOwner, el.repoName, el.existingPostingId]) {
  input.addEventListener("input", updateAssessState);
}

checkConfig();
updateAssessState();
