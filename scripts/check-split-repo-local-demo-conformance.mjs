#!/usr/bin/env node
/**
 * Split-repo local demo conformance check.
 *
 * Validates the split-repo-local-demo.md quickstart guide and its evidence fixture for deterministic, no-live, safe structural expectations.
 */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('split-repo-local-demo');
