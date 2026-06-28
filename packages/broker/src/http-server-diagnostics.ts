// HTTP server configuration diagnostics, extracted from server.ts. Reads the
// keep-alive / headers / request / socket timeouts and connection limits off a
// Node http.Server and derives an explicit socket-reuse policy label so
// operators can interpret rare reused-socket-idle latency in /livez probes
// (#1253). Pure: it reads only the supplied server.
import type { Server } from "node:http";

export function readHttpServerDiagnostics(server: Server | null): {
  keepAliveTimeoutMs: number | null;
  headersTimeoutMs: number | null;
  requestTimeoutMs: number | null;
  timeoutMs: number | null;
  maxRequestsPerSocket: number | null;
  maxConnections: number | null;
  connectionsCheckingIntervalMs: number | null;
  socketReusePolicy: string;
} {
  // Derive an explicit socket-reuse policy label from the server configuration.
  // This makes the keep-alive/reuse intent visible in diagnostics so operators
  // can interpret rare reused-socket-idle latency in /livez probes (#1253).
  const kat = typeof server?.keepAliveTimeout === "number" ? server.keepAliveTimeout : null;
  const mps = typeof server?.maxRequestsPerSocket === "number" ? server.maxRequestsPerSocket : null;
  let socketReusePolicy: string;
  if (kat === 0 || mps === 1) {
    socketReusePolicy = "per-request (no keep-alive reuse)";
  } else if (kat !== null && kat >= 60000) {
    socketReusePolicy = "keep-alive (reuse enabled, long timeout)";
  } else if (kat !== null && kat > 0) {
    socketReusePolicy = "keep-alive (reuse enabled)";
  } else {
    socketReusePolicy = "unknown";
  }
  return {
    keepAliveTimeoutMs: typeof server?.keepAliveTimeout === "number" ? server.keepAliveTimeout : null,
    headersTimeoutMs: typeof server?.headersTimeout === "number" ? server.headersTimeout : null,
    requestTimeoutMs: typeof server?.requestTimeout === "number" ? server.requestTimeout : null,
    timeoutMs: typeof server?.timeout === "number" ? server.timeout : null,
    maxRequestsPerSocket: typeof server?.maxRequestsPerSocket === "number" ? server.maxRequestsPerSocket : null,
    maxConnections: typeof server?.maxConnections === "number" ? server.maxConnections : null,
    connectionsCheckingIntervalMs: typeof (server as any)?.connectionsCheckingInterval === "number"
      ? (server as any).connectionsCheckingInterval
      : null,
    socketReusePolicy,
  };
}
