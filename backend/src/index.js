import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Groq } from "groq-sdk";
import { Octokit } from "octokit";
import { createJobPostingsRoutes } from "./routes/jobPostingsRoutes.js";
import { JobPostingsRepository } from "./repositories/jobPostingsRepository.js";
import { RequirementExtractionService } from "./services/requirementExtractionService.js";
import { JobPostingsController } from "./controllers/jobPostingsController.js";
import { createRepositoriesRoutes } from "./routes/repositoriesRoutes.js";
import { RepositoriesRepository } from "./repositories/repositoriesRepository.js";
import { GithubIngestionService } from "./services/githubIngestionService.js";
import { ChunkingService } from "./services/chunkingService.js";
import { EmbeddingService } from "./services/embeddingService.js";
import { RepositoriesController } from "./controllers/repositoriesController.js";
import { EvidenceRepository } from "./repositories/evidenceRepository.js";
import { EvidenceService } from "./services/evidenceService.js";
import { EvidenceController } from "./controllers/evidenceController.js";
import { createEvidenceRoutes } from "./routes/evidenceRoutes.js";
import { AssessmentRepository } from "./repositories/assessmentRepository.js";
import { AssessmentService } from "./services/assessmentService.js";
import { AssessmentsController } from "./controllers/assessmentsController.js";
import { createAssessmentsRoutes } from "./routes/assessmentsRoutes.js";
import { PollingService } from "./services/pollingService.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Allow the separately hosted Vercel frontend to call this API. Set
// FRONTEND_ORIGIN to the exact deployed frontend origin (scheme + hostname).
if (process.env.FRONTEND_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-polling-secret");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const groqApiKey = process.env.GROQ_API_KEY;
const groqModel = process.env.GROQ_MODEL;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) env vars");
  process.exit(1);
}

if (!groqApiKey) {
  console.error("Missing GROQ_API_KEY env var");
  process.exit(1);
}

if (!groqModel) {
  console.error("Missing GROQ_MODEL env var");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

export { supabase };

export const groq = new Groq({ apiKey: groqApiKey });

export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN || undefined,
  retry: { enabled: false },
  request: { retries: 0 },
  throttle: {
    onRateLimit: () => false,
    onSecondaryRateLimit: () => false,
  },
});

const repository = new JobPostingsRepository({ supabaseClient: supabase });
const extractionService = new RequirementExtractionService({ groqClient: groq, model: groqModel });
const controller = new JobPostingsController({ extractionService, repository });

const repositoriesRepo = new RepositoriesRepository({ supabaseClient: supabase });
const githubService = new GithubIngestionService({ octokit });
const chunkingService = new ChunkingService();
const embeddingService = new EmbeddingService();
const repositoriesController = new RepositoriesController({
  githubService,
  chunkingService,
  embeddingService,
  repository: repositoriesRepo,
});

const evidenceRepo = new EvidenceRepository({ supabaseClient: supabase });
const evidenceService = new EvidenceService({
  embeddingService,
  repository: evidenceRepo,
});
const evidenceController = new EvidenceController({
  evidenceService,
});

const assessmentRepo = new AssessmentRepository({ supabaseClient: supabase });
const assessmentService = new AssessmentService({
  evidenceService,
  groqClient: groq,
  model: groqModel,
  repository: assessmentRepo,
});
const assessmentsController = new AssessmentsController({ assessmentService });

const pollIntervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS) || 300;
export const pollingService = new PollingService({
  githubService,
  chunkingService,
  embeddingService,
  repository: repositoriesRepo,
  assessmentRepository: assessmentRepo,
  assessmentService,
  pollingIntervalMs: pollIntervalSeconds * 1000,
});

if (process.env.ENABLE_POLLING !== "false") {
  pollingService.start();
  pollingService.pollAll().catch((err) => {
    console.error(`[Polling] Startup polling cycle failed: ${err.message}`);
  });
}

app.use("/api", createJobPostingsRoutes({ controller }));
app.use("/api", createRepositoriesRoutes({ controller: repositoriesController }));
app.use("/api", createEvidenceRoutes({ controller: evidenceController }));
app.use("/api", createAssessmentsRoutes({ controller: assessmentsController }));

// Protected polling endpoint — only accessible if POLLING_SECRET is configured
app.post("/api/polling/run", async (req, res) => {
  const secret = process.env.POLLING_SECRET;
  if (!secret) {
    return res.status(404).json({ error: "Polling endpoint is not enabled" });
  }
  const provided = req.headers["x-polling-secret"];
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { repositoryId, owner, name, branch } = req.body || {};
    if (repositoryId || (owner && name)) {
      const result = await pollingService.pollRepository({ repositoryId, owner, name, branch });
      return res.json(result);
    }
    const result = await pollingService.pollAll();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: "Polling cycle failed", message: err.message });
  }
});

// Feature 8: serve the static assessment UI from the same origin as the API so the
// browser never needs CORS. This only serves files; the API itself is unchanged.
// Override the location with FRONTEND_DIR if the UI lives elsewhere.
const frontendDir = process.env.FRONTEND_DIR
  ? path.resolve(process.env.FRONTEND_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../frontend");

app.use("/app", express.static(frontendDir));

app.get("/", (_req, res) => {
  res.json({ name: "W-PS-2 AI Career Coach", status: "ok", ui: "/app/" });
});

app.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("job_postings").select("count", { head: true });
    if (error) throw error;
    res.json({ status: "ok", database: "reachable" });
  } catch (err) {
    res.status(500).json({ status: "degraded", database: "unreachable", error: err.message });
  }
});

app.get("/test/groq", (_req, res) => {
  res.json({
    provider: "groq",
    configured: Boolean(process.env.GROQ_API_KEY),
    model: process.env.GROQ_MODEL || "not configured",
  });
});

app.get("/test/groq/models", async (_req, res) => {
  try {
    const models = await groq.models.list();
    const modelIds = models.data.map(({ id }) => id).sort();
    res.json({
      configured: Boolean(process.env.GROQ_API_KEY),
      currentModel: process.env.GROQ_MODEL,
      currentModelSupported: modelIds.includes(process.env.GROQ_MODEL || ""),
      availableModels: modelIds,
    });
  } catch (err) {
    res.status(502).json({
      error: "Failed to list Groq models",
      message: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

export default app;
