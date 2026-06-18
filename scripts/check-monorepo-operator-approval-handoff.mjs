#!/usr/bin/env node
/** Validate the operator approval handoff packet via data-driven registry. */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-operator-approval-handoff');
