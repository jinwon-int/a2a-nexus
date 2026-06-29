// Audit read route (GET /audit), extracted from the server request closure into
// an explicit-context handler (continuing the #645 dispatcher migration). A
// read-only listing of audit events honoring the URL filters.
import type { ServerResponse } from "node:http";

import { InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import { listAuditEventsForReadPath } from "../task-read-paths.js";
import { auditFiltersFromUrl } from "./read-path-filters.js";
import { sendJson } from "./response.js";

export interface AuditReadRouteContext {
  method: string | undefined;
  path: string;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
}

/** GET /audit — list audit events honoring the URL filters. */
export function handleAuditReadRequest(ctx: AuditReadRouteContext): void {
  const filters = auditFiltersFromUrl(ctx.url);
  sendJson(ctx.res, 200, { items: listAuditEventsForReadPath(ctx.stateStore, ctx.broker, filters) });
}

/** Route dispatcher for the audit read route. Returns true only when handled. */
export function handleAuditReadRouteIfMatched(ctx: AuditReadRouteContext): boolean {
  if (ctx.method === "GET" && ctx.path === "/audit") {
    handleAuditReadRequest(ctx);
    return true;
  }
  return false;
}
