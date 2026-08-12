import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

/**
 * Every inbound route (webhooks and the MCP endpoint alike) requires this same bearer token —
 * Sentry sends it via a custom "Webhook Headers" entry configured on the Internal Integration
 * (`Authorization: Bearer <MCP_SHARED_SECRET>`), and any other caller (MCP client, curl for the
 * generic/developer route) has to present it the same way. Without this, the public URL could be
 * spammed into creating Jira tickets / burning AI calls by anyone who finds it.
 */
export function requireSharedSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.MCP_SHARED_SECRET;
  if (!secret) {
    res.status(500).json({ error: "MCP_SHARED_SECRET is not configured on the server" });
    return;
  }
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token || !safeEqual(token, secret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}