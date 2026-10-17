/**
 * chunking-embedding.test.js
 *
 * Feature 5 focused automated checks:
 *  - Chunk boundaries, overlap, and correct line metadata
 *  - Embedding output: exactly 768 dimensions, normalized values
 *  - Dimension mismatch is rejected BEFORE writing to Supabase
 *
 * Uses a mock embedding pipeline — no model download required.
 * Run with: node --test src/chunking-embedding.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChunkingService } from "./services/chunkingService.js";
import { EmbeddingService } from "./services/embeddingService.js";

// ---------------------------------------------------------------------------
// Mock pipeline factory — returns normalized unit vectors, no real model
// ---------------------------------------------------------------------------

function makeMockPipeline({ dimensions = 768, shouldFail = false } = {}) {
  return async (_task, _modelName) => {
    return async (batch, _opts) => {
      if (shouldFail) throw new Error("Mock pipeline failure");
      return batch.map(() => {
        const v = 1 / Math.sqrt(dimensions);
        return new Array(dimensions).fill(v);
      });
    };
  };
}

// ---------------------------------------------------------------------------
// ChunkingService tests
// ---------------------------------------------------------------------------

test("Chunk boundaries: exact chunk count for file with even multiples", () => {
  const svc = new ChunkingService({ chunkSize: 10, overlap: 0 });
  const content = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
  const chunks = svc.chunkFile({ content, filePath: "a.js", commitSha: "abc" });
  assert.strictEqual(chunks.length, 3, "30 lines / size 10 / overlap 0 = 3 chunks");
});

test("Chunk boundaries: overlap produces correct start/end lines", () => {
  const svc = new ChunkingService({ chunkSize: 50, overlap: 10 });
  const lines = Array.from({ length: 80 }, (_, i) => `const x${i} = ${i};`);
  const content = lines.join("\n");
  const chunks = svc.chunkFile({ content, filePath: "b.js", commitSha: "sha1", blobSha: "blob1" });

  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].chunk_index, 0);
  assert.strictEqual(chunks[0].start_line, 1);
  assert.strictEqual(chunks[0].end_line, 50);
  assert.strictEqual(chunks[1].chunk_index, 1);
  assert.strictEqual(chunks[1].start_line, 41);
  assert.strictEqual(chunks[1].end_line, 80);
});

test("Chunk metadata: file_path, commit_sha, blob_sha preserved on every chunk", () => {
  const svc = new ChunkingService({ chunkSize: 5, overlap: 0 });
  const content = Array.from({ length: 15 }, (_, i) => `// line ${i}`).join("\n");
  const chunks = svc.chunkFile({ content, filePath: "src/utils.ts", commitSha: "deadbeef", blobSha: "blobcafe" });
  for (const chunk of chunks) {
    assert.strictEqual(chunk.file_path, "src/utils.ts");
    assert.strictEqual(chunk.commit_sha, "deadbeef");
    assert.strictEqual(chunk.blob_sha, "blobcafe");
  }
});

test("Chunk metadata: blob_sha defaults to null when omitted", () => {
  const svc = new ChunkingService();
  const chunks = svc.chunkFile({ content: "hello\nworld", filePath: "f.js", commitSha: "abc" });
  for (const chunk of chunks) {
    assert.strictEqual(chunk.blob_sha, null);
  }
});

test("Chunking: empty-only content produces no chunks", () => {
  const svc = new ChunkingService({ chunkSize: 10, overlap: 0 });
  const chunks = svc.chunkFile({ content: "   \n\n   \n", filePath: "empty.js", commitSha: "abc" });
  assert.strictEqual(chunks.length, 0);
});

test("Chunking: single-line file produces exactly one chunk", () => {
  const svc = new ChunkingService({ chunkSize: 10, overlap: 0 });
  const chunks = svc.chunkFile({ content: "const x = 1;", filePath: "single.js", commitSha: "abc" });
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].start_line, 1);
  assert.strictEqual(chunks[0].end_line, 1);
  assert.strictEqual(chunks[0].chunk_index, 0);
});

test("Chunking: determinism — same file + revision produces identical chunks", () => {
  const svc = new ChunkingService({ chunkSize: 20, overlap: 5 });
  const content = Array.from({ length: 50 }, (_, i) => `export const v${i} = ${i};`).join("\n");
  const run1 = svc.chunkFile({ content, filePath: "x.js", commitSha: "rev1" });
  const run2 = svc.chunkFile({ content, filePath: "x.js", commitSha: "rev1" });
  assert.deepStrictEqual(run1, run2);
});

test("Chunking: validation rejects invalid chunkSize/overlap", () => {
  assert.throws(() => new ChunkingService({ chunkSize: 0 }), /positive integer/);
  assert.throws(() => new ChunkingService({ chunkSize: 10, overlap: 10 }), /strictly less than/);
  assert.throws(() => new ChunkingService({ chunkSize: 10, overlap: -1 }), /non-negative/);
});

test("Chunking: chunk_index resets per file when using chunkFiles", () => {
  const svc = new ChunkingService({ chunkSize: 5, overlap: 0 });
  const fileA = Array.from({ length: 10 }, (_, i) => `a${i}`).join("\n");
  const fileB = Array.from({ length: 10 }, (_, i) => `b${i}`).join("\n");
  const chunks = svc.chunkFiles([
    { content: fileA, filePath: "a.js", commitSha: "sha" },
    { content: fileB, filePath: "b.js", commitSha: "sha" },
  ]);
  const aChunks = chunks.filter((c) => c.file_path === "a.js");
  const bChunks = chunks.filter((c) => c.file_path === "b.js");
  assert.strictEqual(aChunks[0].chunk_index, 0);
  assert.strictEqual(bChunks[0].chunk_index, 0);
});

// ---------------------------------------------------------------------------
// EmbeddingService tests
// ---------------------------------------------------------------------------

test("Embedding: output has exactly 768 dimensions", async () => {
  const svc = new EmbeddingService({ pipelineFactory: makeMockPipeline({ dimensions: 768 }) });
  const vecs = await svc.embedTexts(["function foo() { return 42; }"]);
  assert.strictEqual(vecs.length, 1);
  assert.strictEqual(vecs[0].length, 768);
});

test("Embedding: output is L2-normalized (||v||² ≈ 1.0)", async () => {
  const svc = new EmbeddingService({ pipelineFactory: makeMockPipeline({ dimensions: 768 }) });
  const [vec] = await svc.embedTexts(["const x = 1;"]);
  const normSq = vec.reduce((acc, v) => acc + v * v, 0);
  assert.ok(Math.abs(normSq - 1.0) < 1e-6, `Expected ||v||^2 ~= 1, got ${normSq}`);
});

test("Embedding: all values are finite", async () => {
  const svc = new EmbeddingService({ pipelineFactory: makeMockPipeline({ dimensions: 768 }) });
  const [vec] = await svc.embedTexts(["import express from 'express';"]);
  for (const v of vec) {
    assert.ok(Number.isFinite(v), `Non-finite value: ${v}`);
  }
});

test("Embedding: dimension mismatch is rejected before persistence", async () => {
  const svc = new EmbeddingService({
    dimensions: 768,
    pipelineFactory: makeMockPipeline({ dimensions: 384 }),
  });
  await assert.rejects(
    () => svc.embedTexts(["some code"]),
    /Embedding dimension mismatch: expected 768, got 384/
  );
});

test("Embedding: empty input returns empty array without calling pipeline", async () => {
  let pipelineCalled = false;
  const svc = new EmbeddingService({
    pipelineFactory: async () => {
      pipelineCalled = true;
      return async () => [];
    },
  });
  const result = await svc.embedTexts([]);
  assert.deepStrictEqual(result, []);
  assert.strictEqual(pipelineCalled, false);
});

test("Embedding: batching produces vectors for all texts", async () => {
  const svc = new EmbeddingService({
    batchSize: 2,
    pipelineFactory: makeMockPipeline({ dimensions: 768 }),
  });
  const vecs = await svc.embedTexts(["a", "b", "c", "d", "e"]);
  assert.strictEqual(vecs.length, 5);
  for (const v of vecs) assert.strictEqual(v.length, 768);
});

test("Embedding: embedChunks attaches model name, dimensions, and embedding", async () => {
  const svc = new EmbeddingService({ pipelineFactory: makeMockPipeline({ dimensions: 768 }) });
  const chunks = [
    { file_path: "a.js", chunk_index: 0, content: "const a = 1;", start_line: 1, end_line: 1 },
    { file_path: "a.js", chunk_index: 1, content: "const b = 2;", start_line: 2, end_line: 2 },
  ];
  const embedded = await svc.embedChunks(chunks);
  assert.strictEqual(embedded.length, 2);
  for (const ec of embedded) {
    assert.ok(Array.isArray(ec.embedding));
    assert.strictEqual(ec.embedding.length, 768);
    assert.strictEqual(ec.embedding_model, "jinaai/jina-embeddings-v2-base-code");
    assert.strictEqual(ec.embedding_dimensions, 768);
    assert.ok("file_path" in ec);
    assert.ok("chunk_index" in ec);
  }
});

test("Embedding: pipeline is lazy-loaded and reused as singleton", async () => {
  let loadCount = 0;
  const svc = new EmbeddingService({
    pipelineFactory: async () => {
      loadCount++;
      return async (batch) => batch.map(() => new Array(768).fill(1 / Math.sqrt(768)));
    },
  });
  await svc.embedTexts(["a"]);
  await svc.embedTexts(["b"]);
  await svc.embedTexts(["c"]);
  assert.strictEqual(loadCount, 1, "Pipeline must be loaded exactly once");
});
