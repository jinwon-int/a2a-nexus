#!/usr/bin/env node
/** Validate split-repo disposition preflight via data-driven registry. */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-split-repo-disposition-preflight');
