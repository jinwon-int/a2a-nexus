// GitHub routes (POST /github/webhook, GET /github/webhook/health, GET
// /github/poller/health), extracted from the server request closure into
// explicit-context handlers (continuing the #645 dispatcher migration). The
// webhook ingestion service and the bounded poller are server-owned collaborators
// passed in via the route context.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError } from "../core/broker.js";
import { assertGitHubWebhookSignature } from "../core/request-security.js";
import { parseGitHubWebhook, validateWebhookHeaders } from "../github/webhook-parser.js";
import type { GitHubIngestionService } from "../github/ingestion.js";
import type { BoundedPoller } from "../github/bounded-poller.js";
import { readRawBody } from "./body.js";
import { sendJson } from "./response.js";

export interface GitHubRouteContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  githubIngestion: GitHubIngestionService;
  githubWebhookSecret: string | undefined;
  boundedPoller: BoundedPoller | undefined;
}

/** POST /github/webhook — verify, parse, and ingest a GitHub webhook delivery. */
export async function handleGitHubWebhookRequest(ctx: GitHubRouteContext): Promise<void> {
  const { req, res } = ctx;
  const validationError = validateWebhookHeaders(
    req.headers["x-github-event"] as string | undefined,
    req.headers["x-github-delivery"] as string | undefined,
  );
  if (validationError) {
    throw new BrokerError("bad_request", validationError);
  }

  const rawBody = await readRawBody(req);
  assertGitHubWebhookSignature(
    rawBody,
    req.headers["x-hub-signature-256"] as string | undefined,
    ctx.githubWebhookSecret,
  );
  let body: Record<string, unknown> | null = null;
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new BrokerError("bad_request", "invalid JSON body");
    }
  }
  const parsed = parseGitHubWebhook(
    req.headers["x-github-event"] as string,
    req.headers["x-github-delivery"] as string,
    body,
  );
  if (!parsed) {
    throw new BrokerError("bad_request", "unsupported or malformed webhook payload");
  }

  const result = ctx.githubIngestion.ingest(parsed.event, parsed.ctx);
  sendJson(res, result.deduped ? 200 : 201, result);
}

/** GET /github/webhook/health — webhook ingestion replay diagnostics. */
export function handleGitHubWebhookHealthRequest(ctx: GitHubRouteContext): void {
  const replayStats = ctx.githubIngestion.getReplayStats();
  sendJson(ctx.res, 200, {
    ok: true,
    service: "github-ingestion",
    replayStats,
  });
}

/** GET /github/poller/health — bounded-poller status diagnostics. */
export function handleGitHubPollerHealthRequest(ctx: GitHubRouteContext): void {
  const poller = ctx.boundedPoller;
  if (!poller) {
    sendJson(ctx.res, 200, {
      ok: true,
      service: "github-bounded-poller",
      status: "not_started",
    });
    return;
  }
  sendJson(ctx.res, 200, {
    ok: true,
    service: "github-bounded-poller",
    status: "started",
    stats: poller.getStats(),
  });
}

/** Route dispatcher for GitHub routes. Returns true only when handled. */
export async function handleGitHubRouteIfMatched(ctx: GitHubRouteContext): Promise<boolean> {
  if (ctx.method === "POST" && ctx.path === "/github/webhook") {
    await handleGitHubWebhookRequest(ctx);
    return true;
  }
  if (ctx.method === "GET" && ctx.path === "/github/webhook/health") {
    handleGitHubWebhookHealthRequest(ctx);
    return true;
  }
  if (ctx.method === "GET" && ctx.path === "/github/poller/health") {
    handleGitHubPollerHealthRequest(ctx);
    return true;
  }
  return false;
}
