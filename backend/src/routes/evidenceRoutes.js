/**
 * evidenceRoutes.js
 *
 * Route factory for evidence retrieval endpoints.
 * Follows the createXxxRoutes({ controller }) convention used across the backend.
 */

import express from "express";

/**
 * @param {object} options
 * @param {import('../controllers/evidenceController.js').EvidenceController} options.controller
 */
export function createEvidenceRoutes({ controller } = {}) {
  if (!controller) throw new Error("controller is required");

  const router = express.Router();

  // POST /api/evidence/retrieve
  router.post("/evidence/retrieve", (req, res) => {
    void controller.retrieve(req, res);
  });

  // POST /api/evidence (alias)
  router.post("/evidence", (req, res) => {
    void controller.retrieve(req, res);
  });

  return router;
}
