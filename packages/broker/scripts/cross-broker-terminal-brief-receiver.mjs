#!/usr/bin/env node
/**
 * Monorepo package CI syntax target for the split-repo cross-broker receiver.
 * This does not ingest receipts or acknowledge Terminal Briefs.
 */
export function describeReceiverBoundary() {
  return {
    mode: 'source-only',
    receiptIngestion: false,
    terminalAck: false,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(describeReceiverBoundary()));
}
