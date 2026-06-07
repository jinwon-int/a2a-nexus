#!/usr/bin/env node
/**
 * Monorepo package CI syntax target for the split-repo dispatch wrapper.
 * The live dispatch path remains out of scope for a2a-plane package CI.
 */
export function describeDispatchWrapperBoundary() {
  return {
    mode: 'source-only',
    liveDispatch: false,
    providerSend: false,
    terminalAckReplay: false,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(describeDispatchWrapperBoundary()));
}
