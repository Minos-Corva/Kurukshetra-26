import { z } from "zod";

const RequestSchema = z.object({
  sourceUrl: z
    .string({ required_error: "sourceUrl is required" })
    .url("sourceUrl must be a valid URL")
    .refine((url) => url.startsWith("https://"), {
      message: "sourceUrl must be a valid https:// URL",
    }),
  postingText: z
    .string({ required_error: "postingText is required" })
    .min(1, "postingText is required")
    .refine((t) => t.trim().length > 0, {
      message: "postingText must not be empty",
    }),
});

export class JobPostingsController {
  constructor({ extractionService, repository } = {}) {
    if (!extractionService) throw new Error("extractionService is required");
    if (!repository) throw new Error("repository is required");
    this.extractionService = extractionService;
    this.repository = repository;
  }

  async createJobPosting(req, res) {
    const parseResult = RequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Invalid input",
        details: parseResult.error.issues.map((i) => i.message),
      });
    }

    const { sourceUrl, postingText } = parseResult.data;

    try {
      const requirements = await this.extractionService.extractRequirements(postingText);

      const posting = await this.repository.createPosting({
        sourceUrl,
        rawText: postingText,
      });

      const savedRequirements = await this.repository.createRequirements(
        posting.id,
        requirements
      );

      return res.status(201).json({
        posting,
        requirements: savedRequirements,
      });
    } catch (err) {
      const message = err.message || "Unknown error";

      // Safe server errors - never leak provider internals or secrets
      if (message.includes("Groq") || message.includes("groq")) {
        return res.status(502).json({
          error: "Requirement extraction failed",
          message: "Unable to extract requirements from the job posting. Please try again.",
        });
      }

      if (message.includes("supabase") || message.includes("database")) {
        return res.status(500).json({
          error: "Database error",
          message: "Unable to save the job posting. Please try again.",
        });
      }

      return res.status(500).json({
        error: "Internal server error",
        message: "An unexpected error occurred.",
      });
    }
  }
}
