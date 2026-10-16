import express from "express";

export function createJobPostingsRoutes({ controller } = {}) {
  if (!controller) {
    throw new Error("controller is required");
  }

  const router = express.Router();

  router.post("/job-postings", (req, res) => {
    void controller.createJobPosting(req, res);
  });

  return router;
}
