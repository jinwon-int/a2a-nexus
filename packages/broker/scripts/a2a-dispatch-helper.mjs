#!/usr/bin/env node
/**
 * Monorepo package CI syntax target for the split-repo dispatch helper.
 * It is intentionally no-live: no broker task mutation or worker dispatch.
 */
export function describeDispatchHelperBoundary() {
  return {
    mode: 'source-only',
    taskMutation: false,
    workerDispatch: false,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(describeDispatchHelperBoundary()));
}
