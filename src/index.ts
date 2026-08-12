import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import { createMcpRouter } from "./mcp.js";
import { createWebhookRouter } from "./webhooks.js";
import { reloadAppConfigs } from "./config.js";
import { NotImplementedError } from "./errors.js";
import { requireSharedSecret } from "./auth.js";

reloadAppConfigs();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));

app.use("/mcp", requireSharedSecret, createMcpRouter());
app.use("/webhooks", requireSharedSecret, createWebhookRouter());

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof NotImplementedError) {
    res.status(501).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
};
app.use(errorHandler);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`mcp-error-handler listening on :${port}`);
});