#!/usr/bin/env node
/**
 * smoke-test-ingest.js
 *
 * Manual smoke test for Feature 5 — Code Chunking & Embedding.
 *
 * Steps performed:
 *  1. Ingest a small public repository once  → POST /api/repositories/ingest
 *  2. Query Supabase to confirm code_chunks rows exist with correct metadata
 *  3. Spot-check embedding values: finite, approximately normalized
 *  4. Ingest the same repository again → confirm no duplicates
 *
 * Usage:
 *   node src/smoke-test-ingest.js [owner] [repo] [branch]
 *
 * Defaults to: expressjs/express (main branch) — small, public, no auth needed
 *
 * Requirements:
 *   - Backend server must be running: npm run dev (in ./backend/)
 *   - .env must have SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set
 *   - No GITHUB_TOKEN needed for small public repos (60 req/hr unauthenticated)
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const REPO_OWNER  = process.argv[2] || "expressjs";
const REPO_NAME   = process.argv[3] || "express";
const REPO_BRANCH = process.argv[4] || undefined; // default branch

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// ─── helpers ────────────────────────────────────────────────────────────────

function pass(msg)  { console.log(`  ✅  ${msg}`); }
function fail(msg)  { console.error(`  ❌  ${msg}`); process.exitCode = 1; }
function info(msg)  { console.log(`  ℹ   ${msg}`); }
function header(h)  { console.log(`\n── ${h} ${"─".repeat(Math.max(0, 60 - h.length))}`); }

async function ingest(owner, name, branch) {
  const body = { owner, name };
  if (branch) body.branch = branch;

  const res = await fetch(`${BASE_URL}/api/repositories/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function getChunks(repositoryId) {
  const { data, error } = await supabase
    .from("code_chunks")
    .select("id, file_path, start_line, end_line, commit_sha, embedding_model, embedding_dimensions, embedding")
    .eq("repository_id", repositoryId)
    .limit(5);
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return data;
}

async function getChunkCount(repositoryId) {
  const { count, error } = await supabase
    .from("code_chunks")
    .select("*", { count: "exact", head: true })
    .eq("repository_id", repositoryId);
  if (error) throw new Error(`Count query failed: ${error.message}`);
  return count || 0;
}

// ─── run ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nFeature 5 Smoke Test — ${REPO_OWNER}/${REPO_NAME}`);
  console.log(`Server: ${BASE_URL}\n`);

  // ── Step 1: first ingest ──────────────────────────────────────────────────
  header("Step 1: First ingest");
  info(`POST /api/repositories/ingest { owner: "${REPO_OWNER}", name: "${REPO_NAME}" }`);
  info("This will download the model on first run (jinaai/jina-embeddings-v2-base-code, ~350 MB).");
  info("Subsequent runs use the cached model. Wait up to a few minutes on first run.");

  const run1 = await ingest(REPO_OWNER, REPO_NAME, REPO_BRANCH);
  info(`HTTP ${run1.status}`);

  if (run1.status !== 201 && run1.status !== 200) {
    fail(`Expected 201 or 200 on first ingest, got ${run1.status}: ${JSON.stringify(run1.body)}`);
    return;
  }

  const repoId = run1.body.repository?.id;
  const commitSha = run1.body.indexedCommitSha;
  const fileCount = run1.body.fileCount;
  const chunkCount = run1.body.chunkCount;

  if (!repoId)    { fail("Response missing repository.id"); return; }
  if (!commitSha) { fail("Response missing indexedCommitSha"); return; }

  pass(`Ingest complete — status: ${run1.body.status}`);
  pass(`Repository ID: ${repoId}`);
  pass(`Commit SHA: ${commitSha}`);
  pass(`Files processed: ${fileCount}`);
  pass(`Chunks stored: ${chunkCount}`);

  if (chunkCount === 0) {
    fail("chunkCount is 0 — expected non-zero chunks");
    return;
  }

  // ── Step 2: verify Supabase rows ─────────────────────────────────────────
  header("Step 2: Verify Supabase code_chunks rows");

  const chunks = await getChunks(repoId);
  info(`Sampling up to 5 chunks from code_chunks table...`);

  if (chunks.length === 0) {
    fail("No rows found in code_chunks for this repository_id");
    return;
  }
  pass(`Found ${chunks.length} sample rows (total=${chunkCount})`);

  let metaOk = true;
  for (const c of chunks) {
    const issues = [];
    if (!c.file_path)            issues.push("missing file_path");
    if (c.start_line == null)    issues.push("missing start_line");
    if (c.end_line == null)      issues.push("missing end_line");
    if (c.start_line < 1)       issues.push(`start_line < 1 (got ${c.start_line})`);
    if (c.end_line < c.start_line) issues.push("end_line < start_line");
    if (c.commit_sha !== commitSha) issues.push(`commit_sha mismatch: ${c.commit_sha}`);
    if (c.embedding_model !== "jinaai/jina-embeddings-v2-base-code") issues.push(`wrong model: ${c.embedding_model}`);
    if (c.embedding_dimensions !== 768) issues.push(`wrong dimensions: ${c.embedding_dimensions}`);

    if (issues.length > 0) {
      fail(`Chunk ${c.id} (${c.file_path}): ${issues.join("; ")}`);
      metaOk = false;
    }
  }
  if (metaOk) {
    pass("All sampled chunks have correct file_path, line ranges, commit_sha, model, and embedding_dimensions=768");
  }

  // ── Step 3: spot-check embedding values ──────────────────────────────────
  header("Step 3: Spot-check embedding values");

  let embeddingOk = true;
  for (const c of chunks) {
    const vec = c.embedding;
    if (!Array.isArray(vec)) {
      fail(`Chunk ${c.file_path}: embedding is not an array (got ${typeof vec})`);
      embeddingOk = false;
      continue;
    }
    if (vec.length !== 768) {
      fail(`Chunk ${c.file_path}: embedding length = ${vec.length}, expected 768`);
      embeddingOk = false;
      continue;
    }
    const allFinite = vec.every(Number.isFinite);
    if (!allFinite) {
      fail(`Chunk ${c.file_path}: embedding contains non-finite values`);
      embeddingOk = false;
      continue;
    }
    const normSq = vec.reduce((s, v) => s + v * v, 0);
    if (Math.abs(normSq - 1.0) > 0.01) {
      fail(`Chunk ${c.file_path}: ||v||² = ${normSq.toFixed(6)}, expected ~1.0 (normalized)`);
      embeddingOk = false;
    }
  }
  if (embeddingOk) {
    pass("All sampled embeddings are finite and approximately normalized (||v||² ≈ 1.0)");
  }

  // ── Step 4: second ingest (dedup check) ──────────────────────────────────
  header("Step 4: Second ingest — verify no chunk duplication");

  const run2 = await ingest(REPO_OWNER, REPO_NAME, REPO_BRANCH);
  info(`HTTP ${run2.status}`);

  if (run2.status !== 200) {
    fail(`Expected 200 on second ingest (already indexed), got ${run2.status}`);
  } else {
    pass(`Second ingest returned 200 with message: "${run2.body.message}"`);
    const countAfter = await getChunkCount(repoId);
    if (countAfter !== chunkCount) {
      fail(`Chunk count changed after second ingest: before=${chunkCount}, after=${countAfter}`);
    } else {
      pass(`Chunk count unchanged after second ingest: ${countAfter}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  header("Summary");
  if (process.exitCode !== 1) {
    console.log("\n  ✅  All smoke test checks passed.\n");
  } else {
    console.log("\n  ❌  One or more checks failed. See above for details.\n");
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
