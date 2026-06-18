#!/usr/bin/env node
/** Validate the actual canonical flip execution preflight packet via data-driven registry. */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-actual-canonical-flip-execution-preflight');
