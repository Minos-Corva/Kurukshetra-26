/**
 * assessmentsController.js
 *
 * HTTP layer for Feature 7 (requirement-by-requirement assessment).
 * Validates the request with Zod, delegates to AssessmentService, and maps
 * errors to safe responses without leaking credentials or internal details.
 */

import { z } from "zod";
import {
  EntityNotFoundError,
  RepositoryNotIndexedError,
  RequirementsNotFoundError,
} from "../services/evidenceService.js";
import {
  AssessmentModelError,
  InvalidAssessmentOutputError,
  UngroundedAssessmentError,
} from "../services/assessmentService.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AssessRequestSchema = z
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
  .refine((data) => Boolean(data.jobPostingId || data.assessmentId), {
    message: "Either jobPostingId or assessmentId is required",
    path: ["jobPostingId"],
  })
  .refine(
    (data) => {
      if (data.assessmentId) return true;
      return Boolean(data.repositoryId || (data.owner && data.name));
    },
    {
      message:
        "Repository scope (repositoryId, or owner and name) is required when assessmentId is not provided",
      path: ["repositoryId"],
    }
  );

export class AssessmentsController {
  /**
   * @param {object} options
   * @param {import('../services/assessmentService.js').AssessmentService} options.assessmentService
   */
  constructor({ assessmentService } = {}) {
    if (!assessmentService) throw new Error("assessmentService is required");
    this.assessmentService = assessmentService;
  }

  /**
   * POST /api/assessments (alias POST /api/assessments/run)
   */
  async assess(req, res) {
    const parseResult = AssessRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Invalid input",
        details: parseResult.error.issues.map((issue) => issue.message),
      });
    }

    try {
      const result = await this.assessmentService.assess(parseResult.data);
      if (!result) {
        return res.status(404).json({
          error: "Assessment not found",
          message: "The referenced assessment could not be loaded.",
        });
      }
      return res.status(result.created === false ? 200 : 201).json(result);
    } catch (err) {
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

      if (err instanceof AssessmentModelError || err instanceof InvalidAssessmentOutputError) {
        return res.status(502).json({
          error: "Assessment failed",
          message: "The assessment model returned an unusable response. No assessment was saved.",
        });
      }

      if (err instanceof UngroundedAssessmentError) {
        return res.status(502).json({
          error: "Assessment failed",
          message:
            "The assessment model cited evidence that was not returned by retrieval. No assessment was saved.",
        });
      }

      const message = err.message || "Unknown error";

      if (message.includes("dimension mismatch") || message.includes("Embedding") || message.includes("embedding")) {
        return res.status(500).json({
          error: "Embedding error",
          message: "Failed to generate embeddings for the assessment.",
        });
      }

      if (message.includes("supabase") || message.includes("database") || message.includes("RPC")) {
        return res.status(500).json({
          error: "Database error",
          message: "Unable to persist the assessment.",
        });
      }

      return res.status(500).json({
        error: "Assessment failed",
        message: "An unexpected error occurred while assessing the requirements.",
      });
    }
  }
}
