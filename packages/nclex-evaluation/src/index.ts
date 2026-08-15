/**
 * Public surface of a2a-nclex-evaluation (#1601 first slice).
 *
 * Extracted verbatim from packages/broker/src/nclex-evaluation — the broker
 * server keeps only the HTTP route delegation seam and imports the domain
 * from here. This package must not import broker internals.
 */
export {
  NCLEX_RECEIPT_SCHEMA,
  NCLEX_RECEIPT_CANONICALIZATION,
  NclexReceiptValidationError,
  parseReceiptCore,
  receiptIdOf,
  verifySignedReceipt,
} from "./receipt-contract.js";
export type {
  NclexEvaluationKeyring,
  NclexReceiptCore,
  NclexReceiptFinding,
  NclexSignedReceipt,
  VerifyReceiptResult,
} from "./receipt-contract.js";
export { NclexEvaluationReceiptStore } from "./receipt-store.js";
export type { NclexReceiptRecord } from "./receipt-store.js";
export { projectMergeReady } from "./merge-ready.js";
export type { MergeReadyInput, MergeReadyProjection } from "./merge-ready.js";
export { loadNclexEvaluationKeyringFromFile } from "./load-keyring.js";
