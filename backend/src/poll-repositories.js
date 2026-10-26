/**
 * poll-repositories.js
 *
 * CLI utility to execute manual or continuous polling cycles.
 * Usage:
 *   node src/poll-repositories.js                # Poll all tracked repositories once
 *   node src/poll-repositories.js --watch        # Run continuously in background loop
 *   node src/poll-repositories.js <owner> <repo> [branch]  # Poll a single repository once
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Octokit } from "octokit";
import { Groq } from "groq-sdk";
import { RepositoriesRepository } from "./repositories/repositoriesRepository.js";
import { AssessmentRepository } from "./repositories/assessmentRepository.js";
import { EvidenceRepository } from "./repositories/evidenceRepository.js";
import { GithubIngestionService } from "./services/githubIngestionService.js";
import { ChunkingService } from "./services/chunkingService.js";
import { EmbeddingService } from "./services/embeddingService.js";
import { EvidenceService } from "./services/evidenceService.js";
import { AssessmentService } from "./services/assessmentService.js";
import { PollingService } from "./services/pollingService.js";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) env vars");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
if (!process.env.GROQ_API_KEY || !process.env.GROQ_MODEL) {
  console.error("Missing GROQ_API_KEY or GROQ_MODEL; polling reassessment requires both.");
  process.exit(1);
}
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN || undefined,
  retry: { enabled: false },
  request: { retries: 0 },
  throttle: {
    onRateLimit: () => false,
    onSecondaryRateLimit: () => false,
  },
});

const repository = new RepositoriesRepository({ supabaseClient: supabase });
const githubService = new GithubIngestionService({ octokit });
const chunkingService = new ChunkingService();
const embeddingService = new EmbeddingService();
const assessmentRepository = new AssessmentRepository({ supabaseClient: supabase });
const evidenceService = new EvidenceService({
  embeddingService,
  repository: new EvidenceRepository({ supabaseClient: supabase }),
});
const assessmentService = new AssessmentService({
  evidenceService,
  groqClient: groq,
  model: process.env.GROQ_MODEL,
  repository: assessmentRepository,
});

const pollIntervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS) || 60;
const pollingIntervalMs = pollIntervalSeconds * 1000;

const pollingService = new PollingService({
  githubService,
  chunkingService,
  embeddingService,
  repository,
  assessmentRepository,
  assessmentService,
  pollingIntervalMs,
  logger: console,
});

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--watch")) {
    console.log(`Starting continuous repository polling watcher (every ${pollIntervalSeconds}s)... Press Ctrl+C to stop.`);
    pollingService.start();

    // Run first cycle immediately
    await pollingService.pollAll();

    // Keep process alive for timer
    return new Promise(() => {});
  }

  // Poll single repo: node src/poll-repositories.js owner name [branch]
  if (args.length >= 2 && !args[0].startsWith("-")) {
    const owner = args[0];
    const name = args[1];
    const branch = args[2] || undefined;

    console.log(`Polling repository: ${owner}/${name}${branch ? ` (branch: ${branch})` : ""}`);
    const result = await pollingService.pollRepository({ owner, name, branch });
    console.log("Result:", JSON.stringify(result, null, 2));
    process.exit(result.status === "failed" ? 1 : 0);
  }

  // Poll all tracked repositories
  console.log("Polling all tracked repositories once...");
  const outcome = await pollingService.pollAll();
  console.log("Polling cycle complete. Summary:");
  for (const res of outcome.results) {
    const name = res.repositoryName || res.repositoryId;
    if (res.status === "unchanged") {
      console.log(`  ✓ ${name}: unchanged at ${res.commitSha?.slice(0, 7)}`);
    } else if (res.status === "updated") {
      console.log(
        `  ✓ ${name}: updated ${res.oldCommitSha?.slice(0, 7)} -> ${res.newCommitSha?.slice(0, 7)} (+${res.stats?.added}, ~${res.stats?.modified}, -${res.stats?.deleted}, ->${res.stats?.renamed}, ${res.stats?.chunksInserted} chunks inserted, ${res.stats?.chunksDeleted} chunks removed)`
      );
    } else if (res.status === "initial_indexed") {
      console.log(`  ✓ ${name}: initial indexing complete at ${res.newCommitSha?.slice(0, 7)} (${res.chunkCount} chunks)`);
    } else if (res.status === "skipped") {
      console.log(`  - ${name}: skipped (${res.reason})`);
    } else {
      console.log(`  ✗ ${name}: failed (${res.error})`);
    }
    for (const assessment of res.assessments || []) {
      console.log(`      assessment ${assessment.status}: posting ${assessment.jobPostingId || "unknown"}${assessment.assessmentId ? ` → ${assessment.assessmentId}` : ""}${assessment.error ? ` (${assessment.error})` : ""}`);
    }
  }

  const anyFailed = outcome.results.some((r) => r.status === "failed");
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal polling error:", err.message);
  process.exit(1);
});
