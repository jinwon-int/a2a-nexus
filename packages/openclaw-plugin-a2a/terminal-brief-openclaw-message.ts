#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { A2AOperatorTerminalNotificationEnvelope } from "./src/operator-terminal-notifier.js";
import { renderA2AOperatorTerminalBriefTemplate } from "./src/operator-terminal-notifier.js";
import type { A2ATerminalBriefDeliveryAdapterReceiptDecision } from "./src/terminal-brief-delivery-contract.js";

type CliOptions = {
  channel: string;
  target?: string;
  accountId?: string;
  openclawBin: string;
  dryRun: boolean;
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const envelope = readEnvelopeFromStdin();
  const decision = runOpenClawMessageNotifier(envelope, options);
  process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
}

export function runOpenClawMessageNotifier(
  envelope: A2AOperatorTerminalNotificationEnvelope,
  options: CliOptions,
): A2ATerminalBriefDeliveryAdapterReceiptDecision {
  const target = normalizeOptionalString(options.target);
  if (!target) {
    return {
      ackTerminalEvent: false,
      reason: "OpenClaw message notifier target is missing; refusing Terminal Brief ACK",
    };
  }

  const text = renderEnvelopeText(envelope);
  const args = [
    "message",
    "send",
    "--channel",
    options.channel,
    "--target",
    target,
    "--message",
    text,
    "--json",
  ];
  if (options.accountId) {
    args.push("--account", options.accountId);
  }
  if (options.dryRun) {
    args.push("--dry-run");
  }

  const child = spawnSync(options.openclawBin, args, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (child.error) {
    return {
      ackTerminalEvent: false,
      reason: `OpenClaw message notifier failed before receipt confirmation: ${child.error.message}`,
    };
  }
  if (child.status !== 0) {
    return {
      ackTerminalEvent: false,
      reason: `OpenClaw message notifier exited ${child.status ?? "unknown"} before receipt confirmation`,
    };
  }

  let result: unknown;
  try {
    result = JSON.parse(child.stdout.trim());
  } catch {
    return {
      ackTerminalEvent: false,
      reason: "OpenClaw message notifier returned unparseable JSON before receipt confirmation",
    };
  }

  if (readBooleanField(result, "dryRun")) {
    return {
      ackTerminalEvent: false,
      reason: "OpenClaw message notifier dry-run completed; no provider send or terminal ACK",
    };
  }

  const confirmationSource = readReceiptConfirmationSource(result);
  const receiptId = readReceiptId(result);
  if (!confirmationSource) {
    return {
      ackTerminalEvent: false,
      reason: "OpenClaw message notifier did not return current-session/manual receipt confirmation; provider acceptance is not terminal ACK evidence",
      ...(receiptId ? { receiptId } : {}),
    };
  }

  return {
    ackTerminalEvent: true,
    confirmationSource,
    ...(receiptId ? { receiptId } : {}),
    reason: `OpenClaw message notifier receipt confirmed via ${confirmationSource}`,
  };
}

export function renderEnvelopeText(envelope: A2AOperatorTerminalNotificationEnvelope): string {
  const template = normalizeOptionalString(envelope.terminalBriefTemplate);
  if (template) {
    return renderA2AOperatorTerminalBriefTemplate(template, envelope);
  }
  return normalizeOptionalString(envelope.text) ?? envelope.title;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    channel: process.env.A2A_TERMINAL_BRIEF_OPENCLAW_CHANNEL ?? "telegram",
    target: process.env.A2A_TERMINAL_BRIEF_OPENCLAW_TARGET,
    accountId: process.env.A2A_TERMINAL_BRIEF_OPENCLAW_ACCOUNT_ID,
    openclawBin: process.env.OPENCLAW_BIN ?? "openclaw",
    dryRun: false,
    timeoutMs: readNumber(process.env.A2A_TERMINAL_BRIEF_OPENCLAW_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--channel":
        options.channel = requireValue(argv, ++index, arg);
        break;
      case "--target":
      case "--to":
        options.target = requireValue(argv, ++index, arg);
        break;
      case "--account":
      case "--account-id":
        options.accountId = requireValue(argv, ++index, arg);
        break;
      case "--openclaw-bin":
        options.openclawBin = requireValue(argv, ++index, arg);
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(requireValue(argv, ++index, arg));
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    ...options,
    channel: normalizeOptionalString(options.channel) ?? "telegram",
    target: normalizeOptionalString(options.target),
    accountId: normalizeOptionalString(options.accountId),
    openclawBin: normalizeOptionalString(options.openclawBin) ?? "openclaw",
    timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS,
  };
}

function readEnvelopeFromStdin(): A2AOperatorTerminalNotificationEnvelope {
  const text = readFileSync(0, "utf8").trim();
  if (!text) {
    throw new Error("Terminal Brief OpenClaw notifier requires an envelope JSON on stdin");
  }
  const value = JSON.parse(text) as A2AOperatorTerminalNotificationEnvelope;
  if (value?.kind !== "a2a.operator.notification") {
    throw new Error("Terminal Brief OpenClaw notifier received an invalid envelope kind");
  }
  return value;
}

function readReceiptConfirmationSource(
  value: unknown,
): "current_session_visible" | "manual_operator_receipt" | undefined {
  for (const candidate of walkRecords(value)) {
    if (readBooleanCandidate(candidate, ["manual_operator_receipt", "manualOperatorReceipt", "operatorReceiptConfirmed"])) {
      return "manual_operator_receipt";
    }
    if (readBooleanCandidate(candidate, [
      "current_session_visible",
      "currentSessionVisible",
      "userVisible",
      "operatorVisible",
      "visibleToOperator",
    ])) {
      return "current_session_visible";
    }

    const normalized = normalizeReceiptString(
      candidate.confirmationSource ??
        candidate.confirmation_source ??
        candidate.source ??
        candidate.receiptMode ??
        candidate.receipt_mode ??
        candidate.receiptProjection ??
        candidate.receipt_projection ??
        candidate.status ??
        candidate.evidence,
    );
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function readReceiptId(value: unknown): string | undefined {
  for (const candidate of walkRecords(value)) {
    const id = normalizeOptionalString(
      candidate.receiptId ??
        candidate.receipt_id ??
        candidate.messageId ??
        candidate.message_id ??
        candidate.id,
    );
    if (id) {
      return id;
    }
  }
  return undefined;
}

function readBooleanField(value: unknown, field: string): boolean {
  return walkRecords(value).some((record) => record[field] === true);
}

function readBooleanCandidate(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => record[field] === true);
}

function walkRecords(value: unknown, maxDepth = 5): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();

  function visit(item: unknown, depth: number): void {
    if (depth > maxDepth || item === null || typeof item !== "object" || seen.has(item)) {
      return;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    const record = item as Record<string, unknown>;
    records.push(record);
    for (const child of Object.values(record)) {
      visit(child, depth + 1);
    }
  }

  visit(value, 0);
  return records;
}

function normalizeReceiptString(value: unknown): "current_session_visible" | "manual_operator_receipt" | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replace(/[ -]/g, "_");
  if (!normalized) return undefined;
  if (normalized === "manual_operator_receipt" || normalized === "operator_confirmed" || normalized === "operator_visible_manual") {
    return "manual_operator_receipt";
  }
  if (normalized === "current_session_visible" || normalized === "operator_visible" || normalized === "user_visible") {
    return "current_session_visible";
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
