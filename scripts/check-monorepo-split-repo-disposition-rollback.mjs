#!/usr/bin/env node
/** Validate the split-repo disposition rollback packet via data-driven registry. */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-split-repo-disposition-rollback');
