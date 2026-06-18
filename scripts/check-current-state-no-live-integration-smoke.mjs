#!/usr/bin/env node
/**
 * Validate the #506/#508 no-live integration smoke fixture.
 *
 * Safety: source-only fixture/doc validation. No live broker calls, provider sends, GitHub mutations, deploys, restarts, or cleanup actions.
 */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('current-state-no-live-smoke');
