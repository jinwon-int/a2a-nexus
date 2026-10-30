/**
 * Public surface of a2a-review-lifecycle (#2477, #2454 decision record §3).
 *
 * Moved verbatim from packages/broker/src/review-lifecycle. The broker keeps
 * the persistence and transport adapters (review-lineage stores, producer
 * admission, HTTP routes, worker producer) and imports this engine from here.
 * This package must not import broker internals; the composite project has
 * no reference back to the broker, so such an import fails to compile.
 *
 * Every library module is re-exported (`export *`); the 176 top-level export
 * names are collision-free. `scorecard-cli.ts` is an executable entry point
 * (`node packages/review-lifecycle/dist/scorecard-cli.js`) and is deliberately
 * not re-exported.
 */
export * from "./appeal.js";
export * from "./authorized-source.js";
export * from "./canonical-json.js";
export * from "./correction-generation-source.js";
export * from "./enforcement.js";
export * from "./lifecycle.js";
export * from "./lineage-create-source.js";
export * from "./lineage-source-adapter.js";
export * from "./observation.js";
export * from "./operator-cancel-source.js";
export * from "./patch-candidate.js";
export * from "./privacy-retention.js";
export * from "./producer-contract.js";
export * from "./read-model.js";
export * from "./review-report-source.js";
export * from "./reviewer-replacement-source.js";
export * from "./scorecard.js";
export * from "./simulation-fixture.js";
export * from "./source-carrier.js";
export * from "./types.js";
