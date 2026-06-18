#!/usr/bin/env node
/** Validate the canonical flip readiness packet via data-driven registry. */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-canonical-flip-readiness');
