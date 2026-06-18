#!/usr/bin/env node
/** Validate the canonical source flip execution handoff packet via data-driven registry. */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-canonical-source-flip-execution-handoff');
