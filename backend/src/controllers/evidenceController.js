/**
 * evidenceController.js
 *
 * Handles HTTP requests for evidence retrieval:
 * - Validates inputs with Zod
 * - Dispatches to EvidenceService
 * - Translates business/domain errors into appropriate HTTP responses (400, 404, 422, 500)
 * - Returns clean, sanitized responses without exposing secrets or database internals
 */

import { z } from "zod";
import {
  EntityNotFoundError,
  RepositoryNotIndexedError,
  RequirementsNotFoundError,
} from "../services/evidenceService.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RetrieveEvidenceSchema = z
  .object({
    jobPostingId: z
      .string()
      .regex(UUID_REGEX, "jobPostingId must be a valid UUID")
      .optional(),
    assessmentId: z
      .string()
      .regex(UUID_REGEX, "assessmentId must be a valid UUID")
      .optional(),
    repositoryId: z
      .string()
      .regex(UUID_REGEX, "repositoryId must be a valid UUID")
      .optional(),
    owner: z
      .string()
      .min(1, "owner cannot be empty")
      .regex(/^[a-zA-Z0-9_.-]+$/, "owner contains invalid characters")
      .optional(),
    name: z
      .string()
      .min(1, "name cannot be empty")
      .regex(/^[a-zA-Z0-9_.-]+$/, "name contains invalid characters")
      .optional(),
    matchCount: z
      .number({ invalid_type_error: "matchCount must be a number" })
      .int("matchCount must be an integer")
      .min(1, "matchCount must be at least 1")
      .max(50, "matchCount must not exceed 50")
      .optional()
      .default(5),
    similarityThreshold: z
      .number({ invalid_type_error: "similarityThreshold must be a number" })
      .min(0, "similarityThreshold must be between 0 and 1")
      .max(1, "similarityThreshold must be between 0 and 1")
      .optional()
      .default(0.5),
  })
  .refine(
    (data) => Boolean(data.jobPostingId || data.assessmentId),
    {
      message: "Either jobPostingId or assessmentId is required",
      path: ["jobPostingId"],
    }
  )
  .refine(
    (data) => {
      if (data.assessmentId) return true;
      return Boolean(data.repositoryId || (data.owner && data.name));
    },
    {
      message: "Repository scope (repositoryId, or owner and name) is required when assessmentId is not provided",
      path: ["repositoryId"],
    }
  );

export class EvidenceController {
  /**
   * @param {object} options
   * @param {import('../services/evidenceService.js').EvidenceService} options.evidenceService
   */
  constructor({ evidenceService } = {}) {
    if (!evidenceService) throw new Error("evidenceService is required");
    this.evidenceService = evidenceService;
  }

  /**
   * POST /api/evidence/retrieve (or POST /api/evidence)
   */
  async retrieve(req, res) {
    const parseResult = RetrieveEvidenceSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Invalid input",
        details: parseResult.error.issues.map((i) => i.message),
      });
    }

    const {
      jobPostingId,
      assessmentId,
      repositoryId,
      owner,
      name,
      matchCount,
      similarityThreshold,
    } = parseResult.data;

    try {
      const result = await this.evidenceService.retrieveEvidence({
        jobPostingId,
        assessmentId,
        repositoryId,
        owner,
        name,
        matchCount,
        similarityThreshold,
      });

      return res.status(200).json(result);
    } catch (err) {
      const message = err.message || "Unknown error";

      if (err instanceof EntityNotFoundError) {
        return res.status(404).json({
          error: `${err.entityType || "Resource"} not found`,
          message: err.message,
        });
      }

      if (err instanceof RepositoryNotIndexedError) {
        return res.status(422).json({
          error: "Repository not indexed",
          message: err.message,
        });
      }

      if (err instanceof RequirementsNotFoundError) {
        return res.status(404).json({
          error: "Requirements not found",
          message: err.message,
        });
      }

      if (message.includes("dimension mismatch") || message.includes("Embedding") || message.includes("embedding")) {
        return res.status(500).json({
          error: "Embedding error",
          message: "Failed to generate query embeddings for requirements.",
        });
      }

      if (message.includes("supabase") || message.includes("database") || message.includes("RPC")) {
        return res.status(500).json({
          error: "Database error",
          message: "Failed to execute vector search on repository code chunks.",
        });
      }

      return res.status(500).json({
        error: "Evidence retrieval failed",
        message: "An unexpected error occurred while retrieving repository evidence.",
      });
    }
  }
}
