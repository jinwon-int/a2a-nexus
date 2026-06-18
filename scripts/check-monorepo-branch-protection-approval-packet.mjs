#!/usr/bin/env node
/** Validate the branch protection approval packet via data-driven registry. */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-branch-protection-approval-packet');
