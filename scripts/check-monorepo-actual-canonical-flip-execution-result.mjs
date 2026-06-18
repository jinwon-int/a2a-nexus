#!/usr/bin/env node
/** Validate actual canonical flip execution result via data-driven registry. */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-actual-canonical-flip-execution-result');
