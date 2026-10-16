/**
 * chunkingService.js
 *
 * Deterministic, line-based code chunker.  Chunks preserve file_path,
 * start_line/end_line (1-indexed), commit_sha and blob_sha so that
 * assessment_evidence records can link back to the exact lines in GitHub.
 */

const DEFAULT_CHUNK_SIZE = 60; // lines per chunk
const DEFAULT_OVERLAP = 10; // lines shared with the next chunk

export class ChunkingService {
  /**
   * @param {object} [options]
   * @param {number} [options.chunkSize=60]  Lines per chunk
   * @param {number} [options.overlap=10]    Overlap lines between adjacent chunks
   */
  constructor({ chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP } = {}) {
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new Error("chunkSize must be a positive integer");
    }
    if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
      throw new Error(
        "overlap must be a non-negative integer strictly less than chunkSize"
      );
    }
    this.chunkSize = chunkSize;
    this.overlap = overlap;
  }

  /**
   * Chunk a single file into overlapping line-based segments.
   *
   * @param {object} params
   * @param {string} params.content    Full file text
   * @param {string} params.filePath   Relative path in the repository
   * @param {string} params.commitSha  Commit SHA the file was read at
   * @param {string|null} [params.blobSha]  Git blob SHA (nullable)
   * @returns {Array<{
   *   file_path: string, chunk_index: number, content: string,
   *   start_line: number, end_line: number,
   *   commit_sha: string, blob_sha: string|null
   * }>}
   */
  chunkFile({ content, filePath, commitSha, blobSha = null }) {
    if (typeof content !== "string") throw new Error("content must be a string");
    if (!filePath) throw new Error("filePath is required");
    if (!commitSha) throw new Error("commitSha is required");

    const lines = content.split("\n");
    const chunks = [];
    let chunkIndex = 0;
    let start = 0;

    while (start < lines.length) {
      const end = Math.min(start + this.chunkSize, lines.length);
      const chunkContent = lines.slice(start, end).join("\n");

      // Skip chunks that are pure whitespace
      if (chunkContent.trim().length > 0) {
        chunks.push({
          file_path: filePath,
          chunk_index: chunkIndex++,
          content: chunkContent,
          start_line: start + 1, // 1-indexed, inclusive
          end_line: end,         // 1-indexed, inclusive
          commit_sha: commitSha,
          blob_sha: blobSha,
        });
      }

      if (end >= lines.length) break;
      start += this.chunkSize - this.overlap;
    }

    return chunks;
  }

  /**
   * Chunk an array of files and return all chunks in order.
   * chunk_index resets per file; use file_path to disambiguate globally.
   *
   * @param {Array<{content, filePath, commitSha, blobSha?}>} files
   * @returns {Array} All chunks from all files concatenated
   */
  chunkFiles(files) {
    const allChunks = [];
    for (const file of files) {
      allChunks.push(...this.chunkFile(file));
    }
    return allChunks;
  }
}
