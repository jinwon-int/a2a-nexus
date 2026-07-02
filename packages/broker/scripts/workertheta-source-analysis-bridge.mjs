#!/usr/bin/env node
// workertheta keeps a stable worker-env bridge path. The implementation is the
// generic deterministic source-only/no-live bridge so deployed worker config can
// stay host-specific without drifting from the shared artifact.
import "./source-only-local-analysis-bridge.mjs";
