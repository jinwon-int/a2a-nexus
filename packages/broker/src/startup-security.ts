// Broker startup security validation extracted from server.ts: resolve the
// configured worker-auth mode, detect loopback bind hosts, and fail closed on an
// insecure public bind unless an edge secret, strict worker signatures, or an
// explicit insecure-dev opt-in is present. A2AHttpSignatureWorkerAuthMode is
// defined in server.ts and imported here type-only (erased at runtime, so no
// runtime cycle).
import { resolveBooleanEnv } from "./broker-runtime-config.js";
import type { A2AHttpSignatureWorkerAuthMode } from "./server.js";

export function resolveA2AHttpSignatureWorkerAuthMode(value: string | undefined): A2AHttpSignatureWorkerAuthMode {
  const normalized = (value ?? "off").trim().toLowerCase();
  if (normalized === "off" || normalized === "optional" || normalized === "strict") {
    return normalized;
  }
  throw new Error("A2A_HTTP_SIGNATURE_WORKER_AUTH must be one of: off, optional, strict");
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || normalized.startsWith("127.");
}

export function validateBrokerStartupSecurity(options: {
  host: string;
  edgeSecret?: string;
  workerAuth: A2AHttpSignatureWorkerAuthMode;
  workerKeyCount: number;
  allowInsecureDev: boolean;
}): void {
  if (options.allowInsecureDev) {
    return;
  }
  const protectedByEdgeSecret = Boolean(options.edgeSecret);
  const protectedByStrictWorkerSignatures = options.workerAuth === "strict" && options.workerKeyCount > 0;
  if (protectedByEdgeSecret || protectedByStrictWorkerSignatures) {
    return;
  }

  const requiresFailClosed = !isLoopbackBindHost(options.host)
    || process.env.NODE_ENV === "production"
    || resolveBooleanEnv(process.env.A2A_BROKER_DOCKER_RUNTIME, false);
  if (!requiresFailClosed) {
    return;
  }

  throw new Error(
    "insecure broker bind rejected: configure EDGE_SECRET/A2A_EDGE_SECRET or strict A2A_HTTP_SIGNATURE_WORKER_AUTH with a key registry, or set A2A_ALLOW_INSECURE_DEV=1 for local-only development",
  );
}
