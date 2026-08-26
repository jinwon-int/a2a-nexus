// Terminal-outbox /schedz summary helpers extracted from server.ts: counter
// increment/top-entry helpers, oldest-event age, and the outbox summary used by
// the scheduler diagnostics endpoint. Pure functions over an outbox passed in.
import type { TerminalTaskEventOutbox, TerminalTaskOutboxEvent } from "./core/terminal-event-outbox.js";

type TerminalOutboxCounterEntry = { key: string; count: number };

export function incrementCounter(counter: Record<string, number>, key: string | undefined | null): void {
  const normalized = key && key.length > 0 ? key : "unknown";
  counter[normalized] = (counter[normalized] ?? 0) + 1;
}

export function topCounterEntries(counter: Record<string, number>, limit = 5): TerminalOutboxCounterEntry[] {
  return Object.entries(counter)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

export function oldestAgeMs(events: TerminalTaskOutboxEvent[], nowMs: number): number | null {
  let oldest: number | null = null;
  for (const event of events) {
    const timestamp = Date.parse(event.createdAt);
    if (!Number.isFinite(timestamp)) continue;
    oldest = oldest === null ? timestamp : Math.min(oldest, timestamp);
  }
  return oldest === null ? null : Math.max(0, Math.round(nowMs - oldest));
}

export function summarizeTerminalOutboxForSchedz(outbox: TerminalTaskEventOutbox) {
  const limit = 200;
  const retainedCount = outbox.size;
  const events = outbox.tail(limit);
  const nowMs = Date.now();
  const byWorker: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byReceiptStatus: Record<string, number> = {};
  const byBrokerOfRecord: Record<string, number> = {};
  const pendingAckByWorker: Record<string, number> = {};
  const pendingAckByStatus: Record<string, number> = {};
  const pendingAckByReceiptStatus: Record<string, number> = {};
  const pendingAckByBrokerOfRecord: Record<string, number> = {};
  const pendingAckEvents: TerminalTaskOutboxEvent[] = [];
  let oldestPendingAckEvent: TerminalTaskOutboxEvent | null = null;
  let oldestPendingAckAt: number | null = null;

  for (const event of events) {
    const worker = event.payload.worker ?? event.payload.crossBrokerHandoff?.childWorkerId ?? undefined;
    incrementCounter(byWorker, worker);
    incrementCounter(byStatus, event.payload.status);
    incrementCounter(byReceiptStatus, event.receipt?.status);
    incrementCounter(byBrokerOfRecord, event.payload.brokerOfRecordId);
    if (!event.ack) {
      pendingAckEvents.push(event);
      incrementCounter(pendingAckByWorker, worker);
      incrementCounter(pendingAckByStatus, event.payload.status);
      incrementCounter(pendingAckByReceiptStatus, event.receipt?.status);
      incrementCounter(pendingAckByBrokerOfRecord, event.payload.brokerOfRecordId);
      const createdAt = Date.parse(event.createdAt);
      if (Number.isFinite(createdAt) && (oldestPendingAckAt === null || createdAt < oldestPendingAckAt)) {
        oldestPendingAckAt = createdAt;
        oldestPendingAckEvent = event;
      }
    }
  }
  const oldestPendingAckWorker = oldestPendingAckEvent
    ? oldestPendingAckEvent.payload.worker ?? oldestPendingAckEvent.payload.crossBrokerHandoff?.childWorkerId ?? "unknown"
    : null;

  return {
    retainedCount,
    sampledCount: events.length,
    sampleLimit: limit,
    pendingAckCount: pendingAckEvents.length,
    oldestPendingAckAgeMs: oldestPendingAckAt === null ? null : Math.max(0, Math.round(nowMs - oldestPendingAckAt)),
    topWorkers: topCounterEntries(byWorker),
    topStatuses: topCounterEntries(byStatus),
    topReceiptStatuses: topCounterEntries(byReceiptStatus),
    topBrokersOfRecord: topCounterEntries(byBrokerOfRecord),
    topPendingAckWorkers: topCounterEntries(pendingAckByWorker),
    topPendingAckStatuses: topCounterEntries(pendingAckByStatus),
    topPendingAckReceiptStatuses: topCounterEntries(pendingAckByReceiptStatus),
    topPendingAckBrokersOfRecord: topCounterEntries(pendingAckByBrokerOfRecord),
    oldestPendingAckWorker,
    oldestPendingAckStatus: oldestPendingAckEvent?.payload.status ?? null,
    oldestPendingAckReceiptStatus: oldestPendingAckEvent?.receipt?.status ?? null,
    oldestPendingAckBrokerOfRecord: oldestPendingAckEvent?.payload.brokerOfRecordId ?? null,
  };
}
