/**
 * assessmentsRoutes.js
 *
 * Route factory for requirement assessment endpoints.
 * Follows the createXxxRoutes({ controller }) convention used across the backend.
 */

import express from "express";

/**
 * @param {object} options
 * @param {import('../controllers/assessmentsController.js').AssessmentsController} options.controller
 */
export function createAssessmentsRoutes({ controller } = {}) {
  if (!controller) throw new Error("controller is required");

  const router = express.Router();

  // POST /api/assessments
  router.post("/assessments", (req, res) => {
    void controller.assess(req, res);
  });

  // POST /api/assessments/run (alias)
  router.post("/assessments/run", (req, res) => {
    void controller.assess(req, res);
  });

  return router;
}
