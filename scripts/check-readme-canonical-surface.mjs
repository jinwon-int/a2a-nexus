#!/usr/bin/env node
/**
 * Guard the public README surface against regressing to pre-canonical-flip framing.
 *
 * Safety: source-only doc validation. No deploy, restart, provider send, DB mutation, release/tag/npm/Docker publish, credential movement, or repo visibility change.
 */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('readme-canonical-surface');
