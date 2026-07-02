#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { A2AOperatorTerminalNotificationEnvelope } from "./src/operator-terminal-notifier.js";
import { renderA2AOperatorTerminalBriefTemplate } from "./src/operator-terminal-notifier.js";
import type {
  A2ATerminalBriefDeliveryAdapterConfirmationSource,
  A2ATerminalBriefDeliveryAdapterReceiptDecision,
  A2ATerminalBriefDeliveryAdapterReceiptStatus,
} from "./src/terminal-brief-delivery-contract.js";
import { normalizeTerminalBriefConfirmationSource } from "./src/terminal-brief-delivery-contract.js";

type HermesmobileAlphaAdapterOptions = {
  operator: string;
  spoolFile?: string;
  manualReceiptId?: string;
  visibleReceiptId?: string;
  receiptEvidenceFile?: string;
  receiptMaxAgeMs: number;
  reason?: string;
  maxTextChars: number;
};

type HermesmobileAlphaSpoolRecord = {
  schema: "a2a.terminalBrief.hermesmobileAlphaAdapter.spool.v1";
  writtenAt: string;
  operator: string;
  envelopeId: string;
  dedupeKey: string;
  taskId?: string;
  worker?: string;
  status?: string;
  title: string;
  text: string;
  safety: {
    providerSend: false;
    terminalAck: false;
    dryRunOnly: true;
  };
};

const DEFAULT_OPERATOR = "mobileAlpha";
const DEFAULT_MAX_TEXT_CHARS = 4000;
const DEFAULT_RECEIPT_MAX_AGE_MS = 10 * 60 * 1000;
const RECEIPT_EVIDENCE_SCHEMA = "a2a.terminalBrief.hermesmobileAlpha.receipt.v1";

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const envelope = readEnvelopeFromStdin();
  const decision = runHermesmobileAlphaAdapter(envelope, options);
  process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
}

export function runHermesmobileAlphaAdapter(
  envelope: A2AOperatorTerminalNotificationEnvelope,
  options: HermesmobileAlphaAdapterOptions,
): A2ATerminalBriefDeliveryAdapterReceiptDecision {
  validateEnvelope(envelope);

  if (options.spoolFile) {
    appendSpoolRecord(options.spoolFile, buildSpoolRecord(envelope, options));
  }

  const evidenceDecision = buildReceiptDecisionFromEvidenceFile(envelope, options);
  if (evidenceDecision) {
    return evidenceDecision;
  }

  if (options.visibleReceiptId) {
    return {
      ackTerminalEvent: true,
      confirmationSource: "current_session_visible",
      receiptId: options.visibleReceiptId,
      reason: options.reason ?? "Hermes/mobileAlpha adapter received current-session-visible confirmation",
    };
  }

  if (options.manualReceiptId) {
    return {
      ackTerminalEvent: true,
      confirmationSource: "manual_operator_receipt",
      receiptId: options.manualReceiptId,
      reason: options.reason ?? "Hermes/mobileAlpha adapter received manual operator receipt",
    };
  }

  return {
    ackTerminalEvent: false,
    terminalReceiptStatus: "produced",
    reason: options.reason ?? "Hermes/mobileAlpha adapter skeleton dry-run/spool only; operator-visible receipt is not confirmed",
    receiptId: "hermes-mobileAlpha:" + options.operator + ":" + envelope.id,
  };
}

export function buildSpoolRecord(
  envelope: A2AOperatorTerminalNotificationEnvelope,
  options: HermesmobileAlphaAdapterOptions,
): HermesmobileAlphaSpoolRecord {
  const text = clampText(renderEnvelopeText(envelope), options.maxTextChars);
  const envelopeRecord = envelope as Record<string, unknown>;
  const evidence = typeof envelopeRecord.evidence === "object" && envelopeRecord.evidence
    ? envelopeRecord.evidence as Record<string, unknown>
    : {};
  const taskId = normalizeOptionalString(envelopeRecord.taskId) ?? normalizeOptionalString(evidence.taskId);
  const worker = normalizeOptionalString(envelopeRecord.worker)
    ?? normalizeOptionalString(envelopeRecord.workerId)
    ?? normalizeOptionalString(evidence.worker)
    ?? normalizeOptionalString(evidence.workerId);
  const status = normalizeOptionalString(envelopeRecord.status) ?? normalizeOptionalString(evidence.status);
  return {
    schema: "a2a.terminalBrief.hermesmobileAlphaAdapter.spool.v1",
    writtenAt: new Date().toISOString(),
    operator: options.operator,
    envelopeId: envelope.id,
    dedupeKey: envelope.dedupeKey,
    ...(taskId ? { taskId } : {}),
    ...(worker ? { worker } : {}),
    ...(status ? { status } : {}),
    title: envelope.title,
    text,
    safety: {
      providerSend: false,
      terminalAck: false,
      dryRunOnly: true,
    },
  };
}

function parseArgs(argv: readonly string[]): HermesmobileAlphaAdapterOptions {
  const options: HermesmobileAlphaAdapterOptions = {
    operator: process.env.A2A_TERMINAL_BRIEF_HERMES_OPERATOR ?? DEFAULT_OPERATOR,
    spoolFile: process.env.A2A_TERMINAL_BRIEF_HERMES_SPOOL_FILE,
    manualReceiptId: process.env.A2A_TERMINAL_BRIEF_HERMES_MANUAL_RECEIPT_ID,
    visibleReceiptId: process.env.A2A_TERMINAL_BRIEF_HERMES_VISIBLE_RECEIPT_ID,
    receiptEvidenceFile: process.env.A2A_TERMINAL_BRIEF_HERMES_RECEIPT_EVIDENCE_FILE,
    receiptMaxAgeMs: readNumber(process.env.A2A_TERMINAL_BRIEF_HERMES_RECEIPT_MAX_AGE_MS) ?? DEFAULT_RECEIPT_MAX_AGE_MS,
    reason: process.env.A2A_TERMINAL_BRIEF_HERMES_REASON,
    maxTextChars: readNumber(process.env.A2A_TERMINAL_BRIEF_HERMES_MAX_TEXT_CHARS) ?? DEFAULT_MAX_TEXT_CHARS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--operator":
        options.operator = requireValue(argv, ++index, arg);
        break;
      case "--spool-file":
        options.spoolFile = requireValue(argv, ++index, arg);
        break;
      case "--manual-receipt-id":
        options.manualReceiptId = requireValue(argv, ++index, arg);
        break;
      case "--visible-receipt-id":
        options.visibleReceiptId = requireValue(argv, ++index, arg);
        break;
      case "--receipt-evidence-file":
        options.receiptEvidenceFile = requireValue(argv, ++index, arg);
        break;
      case "--receipt-max-age-ms":
        options.receiptMaxAgeMs = Number(requireValue(argv, ++index, arg));
        break;
      case "--reason":
        options.reason = requireValue(argv, ++index, arg);
        break;
      case "--max-text-chars":
        options.maxTextChars = Number(requireValue(argv, ++index, arg));
        break;
      case "--dry-run":
        options.manualReceiptId = undefined;
        options.visibleReceiptId = undefined;
        options.receiptEvidenceFile = undefined;
        break;
      default:
        throw new Error("Unknown argument: " + arg);
    }
  }

  return {
    operator: normalizeOptionalString(options.operator) ?? DEFAULT_OPERATOR,
    spoolFile: normalizeOptionalString(options.spoolFile),
    manualReceiptId: normalizeOptionalString(options.manualReceiptId),
    visibleReceiptId: normalizeOptionalString(options.visibleReceiptId),
    receiptEvidenceFile: normalizeOptionalString(options.receiptEvidenceFile),
    receiptMaxAgeMs: Number.isFinite(options.receiptMaxAgeMs) && options.receiptMaxAgeMs > 0
      ? Math.floor(options.receiptMaxAgeMs)
      : DEFAULT_RECEIPT_MAX_AGE_MS,
    reason: normalizeOptionalString(options.reason),
    maxTextChars: Number.isFinite(options.maxTextChars) && options.maxTextChars > 0
      ? Math.floor(options.maxTextChars)
      : DEFAULT_MAX_TEXT_CHARS,
  };
}

function readEnvelopeFromStdin(): A2AOperatorTerminalNotificationEnvelope {
  const text = readFileSync(0, "utf8").trim();
  if (!text) {
    throw new Error("Hermes/mobileAlpha adapter requires a Terminal Brief envelope JSON on stdin");
  }
  return JSON.parse(text) as A2AOperatorTerminalNotificationEnvelope;
}

function validateEnvelope(envelope: A2AOperatorTerminalNotificationEnvelope): void {
  if (envelope?.kind !== "a2a.operator.notification") {
    throw new Error("Hermes/mobileAlpha adapter received an invalid envelope kind");
  }
  if (!normalizeOptionalString(envelope.id) || !normalizeOptionalString(envelope.dedupeKey)) {
    throw new Error("Hermes/mobileAlpha adapter requires envelope id and dedupeKey");
  }
}

function appendSpoolRecord(filePath: string, record: HermesmobileAlphaSpoolRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(record) + "\n", { mode: 0o600 });
}

function buildReceiptDecisionFromEvidenceFile(
  envelope: A2AOperatorTerminalNotificationEnvelope,
  options: HermesmobileAlphaAdapterOptions,
): A2ATerminalBriefDeliveryAdapterReceiptDecision | undefined {
  if (!options.receiptEvidenceFile) return undefined;
  const readResult = readReceiptEvidenceRecords(options.receiptEvidenceFile);
  if (!readResult.ok) {
    return rejectedReceiptDecision("failed", readResult.reason);
  }
  const records = readResult.records;
  if (records.length === 0) {
    return rejectedReceiptDecision("failed", "Hermes/mobileAlpha receipt evidence file had no records");
  }

  const reasons: string[] = [];
  let strongestStatus: A2ATerminalBriefDeliveryAdapterReceiptStatus = "failed";
  for (const record of records.slice().reverse()) {
    const validation = validateReceiptEvidenceRecord(record, envelope, options);
    if (validation.ok) {
      return {
        ackTerminalEvent: true,
        confirmationSource: validation.confirmationSource,
        receiptId: validation.receiptId,
        reason: options.reason ?? "Hermes/mobileAlpha receipt evidence confirmed " + validation.confirmationSource,
      };
    }
    reasons.push(validation.reason);
    if (validation.status === "stale") strongestStatus = "stale";
  }

  return rejectedReceiptDecision(
    strongestStatus,
    "Hermes/mobileAlpha receipt evidence rejected: " + (reasons[0] ?? "no matching record"),
  );
}

function readReceiptEvidenceRecords(filePath: string): { ok: true; records: unknown[] } | { ok: false; reason: string } {
  try {
    const text = readFileSync(filePath, "utf8").trim();
    if (!text) return { ok: true, records: [] };
    if (text.startsWith("[")) {
      const parsed = JSON.parse(text);
      return { ok: true, records: Array.isArray(parsed) ? parsed : [] };
    }
    if (text.startsWith("{")) {
      try {
        return { ok: true, records: [JSON.parse(text)] };
      } catch {
        // Fall through to JSONL parsing below.
      }
    }
    const records = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { ok: true, records };
  } catch (error) {
    return {
      ok: false,
      reason: "Hermes/mobileAlpha receipt evidence file could not be read or parsed: " + (
        error instanceof Error ? error.message : String(error)
      ),
    };
  }
}

function validateReceiptEvidenceRecord(
  value: unknown,
  envelope: A2AOperatorTerminalNotificationEnvelope,
  options: HermesmobileAlphaAdapterOptions,
): (
  | { ok: true; confirmationSource: A2ATerminalBriefDeliveryAdapterConfirmationSource; receiptId: string }
  | { ok: false; reason: string; status: A2ATerminalBriefDeliveryAdapterReceiptStatus }
) {
  if (!value || typeof value !== "object") {
    return { ok: false, status: "failed", reason: "record is not an object" };
  }
  const record = value as Record<string, unknown>;
  const schema = normalizeOptionalString(record.schema);
  if (schema && schema !== RECEIPT_EVIDENCE_SCHEMA) {
    return { ok: false, status: "failed", reason: "unsupported receipt evidence schema" };
  }
  const operator = normalizeOptionalString(record.operator);
  if (operator !== options.operator) {
    return { ok: false, status: "failed", reason: "operator mismatch" };
  }
  if (!recordMatchesEnvelope(record, envelope)) {
    return { ok: false, status: "failed", reason: "record does not match envelope id, dedupeKey, or taskId" };
  }
  const confirmationSource = normalizeTerminalBriefConfirmationSource(
    record.confirmationSource ?? record.confirmation_source ?? record.source ?? record.receiptMode ?? record.receipt_mode,
  );
  if (!confirmationSource) {
    return { ok: false, status: "failed", reason: "missing current-session-visible or manual receipt source" };
  }
  if (!statusSupportsConfirmation(record.status, confirmationSource)) {
    return { ok: false, status: "failed", reason: "receipt status does not prove " + confirmationSource };
  }
  const receiptId = normalizeOptionalString(record.receiptId ?? record.receipt_id);
  if (!receiptId) {
    return { ok: false, status: "failed", reason: "receiptId is required" };
  }
  const observedAt = normalizeOptionalString(record.observedAt ?? record.observed_at ?? record.updatedAt ?? record.updated_at);
  const observedAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (!Number.isFinite(observedAtMs)) {
    return { ok: false, status: "failed", reason: "valid observedAt timestamp is required" };
  }
  const nowMs = Date.now();
  if (observedAtMs > nowMs + 60_000) {
    return { ok: false, status: "failed", reason: "receipt evidence timestamp is too far in the future" };
  }
  if (nowMs - observedAtMs > options.receiptMaxAgeMs) {
    return { ok: false, status: "stale", reason: "receipt evidence is stale" };
  }
  return { ok: true, confirmationSource, receiptId };
}

function recordMatchesEnvelope(record: Record<string, unknown>, envelope: A2AOperatorTerminalNotificationEnvelope): boolean {
  const envelopeId = normalizeOptionalString(record.envelopeId ?? record.envelope_id);
  if (envelopeId && envelopeId === envelope.id) return true;
  const dedupeKey = normalizeOptionalString(record.dedupeKey ?? record.dedupe_key);
  if (dedupeKey && dedupeKey === envelope.dedupeKey) return true;
  const taskId = normalizeOptionalString(record.taskId ?? record.task_id);
  return Boolean(taskId && taskId === readEnvelopeTaskId(envelope));
}

function readEnvelopeTaskId(envelope: A2AOperatorTerminalNotificationEnvelope): string | undefined {
  const envelopeRecord = envelope as Record<string, unknown>;
  const evidence = typeof envelopeRecord.evidence === "object" && envelopeRecord.evidence
    ? envelopeRecord.evidence as Record<string, unknown>
    : {};
  return normalizeOptionalString(envelopeRecord.taskId) ?? normalizeOptionalString(evidence.taskId);
}

function statusSupportsConfirmation(
  value: unknown,
  confirmationSource: A2ATerminalBriefDeliveryAdapterConfirmationSource,
): boolean {
  const status = normalizeOptionalString(value)?.toLowerCase().replace(/[ -]/g, "_");
  if (!status) return false;
  if (status === "confirmed") return true;
  if (confirmationSource === "current_session_visible") {
    return status === "visible" || status === "current_session_visible" || status === "operator_visible" || status === "user_visible";
  }
  return status === "manual_operator_receipt" || status === "operator_confirmed" || status === "received";
}

function rejectedReceiptDecision(
  terminalReceiptStatus: A2ATerminalBriefDeliveryAdapterReceiptStatus,
  reason: string,
): A2ATerminalBriefDeliveryAdapterReceiptDecision {
  return {
    ackTerminalEvent: false,
    terminalReceiptStatus,
    reason,
  };
}

function renderEnvelopeText(envelope: A2AOperatorTerminalNotificationEnvelope): string {
  const template = normalizeOptionalString(envelope.terminalBriefTemplate);
  if (template) {
    return renderA2AOperatorTerminalBriefTemplate(template, envelope);
  }
  return normalizeOptionalString(envelope.text) ?? envelope.title;
}

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + "…";
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
    throw new Error(flag + " requires a value");
  }
  return value;
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
