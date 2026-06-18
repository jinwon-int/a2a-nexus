#!/usr/bin/env node
/** Validate the final operator sign-off matrix via data-driven registry. */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-final-operator-signoff');
