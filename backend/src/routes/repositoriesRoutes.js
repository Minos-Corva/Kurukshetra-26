/**
 * repositoriesRoutes.js
 *
 * Route factory for repository-ingestion endpoints.
 * Follows the same createXxxRoutes({ controller }) convention used throughout the backend.
 */

import express from "express";

/**
 * @param {object} options
 * @param {import('../controllers/repositoriesController.js').RepositoriesController} options.controller
 */
export function createRepositoriesRoutes({ controller } = {}) {
  if (!controller) throw new Error("controller is required");

  const router = express.Router();

  // POST /api/repositories/ingest
  router.post("/repositories/ingest", (req, res) => {
    void controller.ingest(req, res);
  });

  return router;
}
