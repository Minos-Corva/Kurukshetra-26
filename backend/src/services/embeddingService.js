/**
 * embeddingService.js
 *
 * Generates code embeddings using @huggingface/transformers.
 * - Selected model: "jinaai/jina-embeddings-v2-base-code"
 * - Target dimension: 768
 * - Lazy loaded pipeline singleton
 * - Batch processing to prevent memory exhaustion
 * - Strict dimension validation
 */

import { pipeline } from "@huggingface/transformers";

export const DEFAULT_EMBEDDING_MODEL = "jinaai/jina-embeddings-v2-base-code";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
const DEFAULT_BATCH_SIZE = 32;

export class EmbeddingService {
  /**
   * @param {object} [options]
   * @param {string} [options.model]
   * @param {number} [options.dimensions]
   * @param {number} [options.batchSize]
   * @param {Function} [options.pipelineFactory] Custom pipeline loader (useful for testing/mocking)
   */
  constructor({
    model = DEFAULT_EMBEDDING_MODEL,
    dimensions = DEFAULT_EMBEDDING_DIMENSIONS,
    batchSize = DEFAULT_BATCH_SIZE,
    pipelineFactory = null,
  } = {}) {
    this.model = model;
    this.dimensions = dimensions;
    this.batchSize = batchSize;
    this.pipelineFactory = pipelineFactory || ((task, modelName) => pipeline(task, modelName));
    this._pipelinePromise = null;
  }

  /**
   * Lazy load the feature-extraction pipeline once.
   */
  async getPipeline() {
    if (!this._pipelinePromise) {
      this._pipelinePromise = this.pipelineFactory("feature-extraction", this.model);
    }
    return this._pipelinePromise;
  }

  /**
   * Embed an array of raw text strings.
   *
   * @param {string[]} texts
   * @returns {Promise<number[][]>} Array of 768-dim float arrays
   */
  async embedTexts(texts) {
    if (!Array.isArray(texts)) {
      throw new Error("texts must be an array");
    }
    if (texts.length === 0) {
      return [];
    }

    const extractor = await this.getPipeline();
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);

      // Run feature-extraction with mean pooling and normalization
      const output = await extractor(batch, {
        pooling: "mean",
        normalize: true,
      });

      // Extract raw arrays from Tensor or output
      let batchVectors;
      if (typeof output.tolist === "function") {
        batchVectors = output.tolist();
      } else if (Array.isArray(output)) {
        batchVectors = output;
      } else if (output.data && output.dims) {
        // Fallback for raw Tensor data
        const [numItems, dim] = output.dims;
        batchVectors = [];
        for (let b = 0; b < numItems; b++) {
          const slice = Array.from(output.data.slice(b * dim, (b + 1) * dim));
          batchVectors.push(slice);
        }
      } else {
        throw new Error("Unexpected embedding output format from transformers pipeline");
      }

      // If single item passed, tolist() might return 1D array
      if (batch.length === 1 && Array.isArray(batchVectors[0]) === false) {
        batchVectors = [batchVectors];
      }

      for (let j = 0; j < batchVectors.length; j++) {
        const vec = batchVectors[j];
        if (!Array.isArray(vec)) {
          throw new Error("Embedding vector is not an array");
        }
        if (vec.length !== this.dimensions) {
          throw new Error(
            `Embedding dimension mismatch: expected ${this.dimensions}, got ${vec.length}`
          );
        }
        allEmbeddings.push(vec);
      }
    }

    return allEmbeddings;
  }

  /**
   * Embed an array of chunk objects and attach embedding metadata.
   *
   * @param {Array<{ content: string, [key: string]: any }>} chunks
   * @returns {Promise<Array<object>>}
   */
  async embedChunks(chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return [];
    }

    const texts = chunks.map((c) => c.content);
    const embeddings = await this.embedTexts(texts);

    return chunks.map((chunk, idx) => ({
      ...chunk,
      embedding: embeddings[idx],
      embedding_model: this.model,
      embedding_dimensions: this.dimensions,
    }));
  }
}
