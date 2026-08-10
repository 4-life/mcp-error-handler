import { Router } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { reportError } from "./orchestrator.js";
import type { ErrorReport } from "./types.js";

const reportErrorInputShape = {
  app_id: z.string().describe("Which onboarded app this error belongs to — matches a config/apps/<app_id>.yaml file"),
  data: z.unknown().describe("The raw error data: a tracker's native JSON payload, or a plain-text description"),
  source: z.enum(["sentry", "bugsnag", "developer", "other"]).optional().describe("Where this report came from — logged only, never branched on"),
};

function buildServer(): McpServer {
  const server = new McpServer({ name: "mcp-error-handler", version: "0.1.0" });

  server.registerTool(
    "report_error",
    {
      title: "Report an application error",
      description:
        "Turns an error report into a Jira ticket, a git-blame-assigned owner, a Slack notification, and — once local and CI tests pass — a reviewable GitHub PR.",
      inputSchema: reportErrorInputShape,
    },
    async ({ app_id, data, source }) => {
      const report: ErrorReport = { appId: app_id, data, source: source ?? "developer" };
      const result = await reportError(report);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}

/**
 * Stateless Streamable HTTP MCP endpoint: one server+transport pair per request. There's no
 * cross-request session state here (report_error is fire-and-forget per call), so statelessness
 * keeps this simple — revisit if a future get_job_status tool needs to stream progress.
 */
export function createMcpRouter(): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}