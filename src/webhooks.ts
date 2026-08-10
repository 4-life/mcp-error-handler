import { Router } from "express";
import { reportError } from "./orchestrator.js";
import type { ErrorReport } from "./types.js";

/**
 * Plain HTTP webhook routes, one per error tracker. Each just forwards the provider's native
 * payload into reportError untouched — no per-provider parsing lives here or in the
 * orchestrator; that's what keeps report_error source-agnostic. The app_id lives in the route,
 * set once per project when configuring the webhook in Sentry/Bugsnag/etc.
 */
export function createWebhookRouter(): Router {
  const router = Router();

  router.post("/sentry/:appId", async (req, res, next) => {
    try {
      const report: ErrorReport = { appId: req.params.appId, data: req.body, source: "sentry" };
      res.status(202).json(await reportError(report));
    } catch (err) {
      next(err);
    }
  });

  router.post("/bugsnag/:appId", async (req, res, next) => {
    try {
      const report: ErrorReport = { appId: req.params.appId, data: req.body, source: "bugsnag" };
      res.status(202).json(await reportError(report));
    } catch (err) {
      next(err);
    }
  });

  router.post("/generic/:appId", async (req, res, next) => {
    try {
      const report: ErrorReport = { appId: req.params.appId, data: req.body, source: "other" };
      res.status(202).json(await reportError(report));
    } catch (err) {
      next(err);
    }
  });

  return router;
}