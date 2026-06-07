#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { once } from "node:events";
import {
  createA2ATerminalBriefSidecar,
  createCommandNotificationHandler,
  type A2ATerminalBriefSidecarConfig,
} from "./src/terminal-brief-sidecar.js";

type CliOptions = A2ATerminalBriefSidecarConfig & {
  once?: boolean;
  statusOnly?: boolean;
  doctorOnly?: boolean;
  deliveryCommand?: string;
  deliveryCommandArgs: string[];
  edgeSecretEnv?: string;
  edgeSecretFile?: string;
  requesterId?: string;
  requesterKind?: string;
  requesterRole?: string;
  requesterDisplayName?: string;
};

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const config: A2ATerminalBriefSidecarConfig = {
    ...options,
    edgeSecret: options.edgeSecret ?? readEdgeSecret(options),
    requester: options.requester ?? buildRequester(options),
  };
  const notifyOperator = options.deliveryCommand
    ? createCommandNotificationHandler({
        command: options.deliveryCommand,
        args: options.deliveryCommandArgs,
      })
    : undefined;
  const sidecar = createA2ATerminalBriefSidecar(config, {
    ...(notifyOperator ? { notifyOperator } : {}),
    ...(options.once
      ? {
          waitForRetry: async () => {
            throw new Error("one-shot sidecar cycle complete");
          },
        }
      : {}),
  });

  if (options.statusOnly) {
    process.stdout.write(JSON.stringify(sidecar.getStatus(), null, 2) + "\n");
    return;
  }

  if (options.doctorOnly) {
    sidecar.start();
    await sidecar.waitForIdle();
    process.stdout.write(JSON.stringify(sidecar.doctor(), null, 2) + "\n");
    sidecar.shutdown();
    return;
  }

  process.stdout.write(JSON.stringify(sidecar.start(), null, 2) + "\n");

  if (options.once) {
    await sidecar.waitForIdle();
    sidecar.shutdown();
    process.stdout.write(JSON.stringify(sidecar.getStatus(), null, 2) + "\n");
    return;
  }

  const stop = () => sidecar.shutdown();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: process.env.A2A_BROKER_BASE_URL ?? "http://127.0.0.1:8787",
    cursorFile: process.env.A2A_TERMINAL_BRIEF_CURSOR_FILE,
    terminalOutboxCursor: process.env.A2A_TERMINAL_BRIEF_CURSOR,
    terminalOutboxPollMs: readNumber(process.env.A2A_TERMINAL_BRIEF_POLL_MS),
    terminalOutboxLimit: readNumber(process.env.A2A_TERMINAL_BRIEF_LIMIT),
    terminalOutboxAllowedIds: splitCsv(process.env.A2A_TERMINAL_BRIEF_ALLOW_IDS),
    deliveryMode: "dry-run",
    operatorEventStreamEnabled: false,
    terminalOutboxHistoricalReplay: "suppress",
    terminalEventHistoricalReplay: "suppress",
    terminalOutboxReconcileUnackedOnStart: false,
    handoffBrokerId: process.env.A2A_TERMINAL_BRIEF_HANDOFF_BROKER_ID,
    deliveryCommandArgs: [],
    edgeSecretEnv: "A2A_EDGE_SECRET",
    requesterId: process.env.A2A_TERMINAL_BRIEF_REQUESTER_ID ?? "terminal-brief-sidecar",
    requesterKind: process.env.A2A_TERMINAL_BRIEF_REQUESTER_KIND ?? "service",
    requesterRole: process.env.A2A_TERMINAL_BRIEF_REQUESTER_ROLE ?? "hub",
    requesterDisplayName: process.env.A2A_TERMINAL_BRIEF_REQUESTER_DISPLAY_NAME,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--base-url":
        options.baseUrl = requireValue(argv, ++index, arg);
        break;
      case "--cursor-file":
        options.cursorFile = requireValue(argv, ++index, arg);
        break;
      case "--cursor":
      case "--terminal-outbox-cursor":
        options.terminalOutboxCursor = requireValue(argv, ++index, arg);
        break;
      case "--allow-id":
        options.terminalOutboxAllowedIds = [
          ...(options.terminalOutboxAllowedIds ?? []),
          requireValue(argv, ++index, arg),
        ];
        break;
      case "--poll-ms":
        options.terminalOutboxPollMs = Number(requireValue(argv, ++index, arg));
        break;
      case "--limit":
        options.terminalOutboxLimit = Number(requireValue(argv, ++index, arg));
        break;
      case "--edge-secret-env":
        options.edgeSecretEnv = requireValue(argv, ++index, arg);
        break;
      case "--edge-secret-file":
        options.edgeSecretFile = requireValue(argv, ++index, arg);
        break;
      case "--requester-id":
        options.requesterId = requireValue(argv, ++index, arg);
        break;
      case "--requester-kind":
        options.requesterKind = requireValue(argv, ++index, arg);
        break;
      case "--requester-role":
        options.requesterRole = requireValue(argv, ++index, arg);
        break;
      case "--requester-display-name":
        options.requesterDisplayName = requireValue(argv, ++index, arg);
        break;
      case "--delivery-command":
        options.deliveryCommand = requireValue(argv, ++index, arg);
        options.deliveryMode = "external";
        break;
      case "--delivery-command-arg":
        options.deliveryCommandArgs.push(requireValue(argv, ++index, arg));
        break;
      case "--enable-operator-stream":
        options.operatorEventStreamEnabled = true;
        break;
      case "--notify-historical":
        options.terminalOutboxHistoricalReplay = "notify";
        options.terminalEventHistoricalReplay = "notify";
        break;
      case "--reconcile-unacked-on-start":
        options.terminalOutboxReconcileUnackedOnStart = true;
        break;
      case "--handoff-broker-id":
        options.handoffBrokerId = requireValue(argv, ++index, arg);
        break;
      case "--once":
        options.once = true;
        break;
      case "--status":
        options.statusOnly = true;
        break;
      case "--doctor":
        options.doctorOnly = true;
        break;
      case "--dry-run":
        options.deliveryMode = "dry-run";
        options.deliveryCommand = undefined;
        options.deliveryCommandArgs = [];
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function buildRequester(options: CliOptions): A2ATerminalBriefSidecarConfig["requester"] {
  const id = normalizeOptionalString(options.requesterId);
  if (!id) return undefined;
  return {
    id,
    kind: normalizeRequesterKind(options.requesterKind) ?? "service",
    role: normalizeRequesterRole(options.requesterRole) ?? "hub",
    ...(normalizeOptionalString(options.requesterDisplayName) ? { displayName: normalizeOptionalString(options.requesterDisplayName) } : {}),
  };
}

function readEdgeSecret(options: CliOptions): string | undefined {
  if (options.edgeSecretFile) {
    return readFileSync(options.edgeSecretFile, "utf8").trim() || undefined;
  }
  return options.edgeSecretEnv ? process.env[options.edgeSecretEnv]?.trim() || undefined : undefined;
}

function splitCsv(value: string | undefined): string[] {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRequesterKind(value: unknown): "session" | "node" | "user" | "service" | undefined {
  return value === "session" || value === "node" || value === "user" || value === "service" ? value : undefined;
}

function normalizeRequesterRole(value: unknown): "hub" | "live-trader" | "researcher" | "analyst" | "operator" | undefined {
  return value === "hub" || value === "live-trader" || value === "researcher" || value === "analyst" || value === "operator"
    ? value
    : undefined;
}

function readNumber(value: string | undefined): number | undefined {
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
