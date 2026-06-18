#!/usr/bin/env node
/**
 * Validate the #534 monorepo phase-3 package CI parity gate.
 *
 * Safety: source-only fixture/doc validation. No import, package mirror
 * refresh, history rewrite, release, publish, visibility, live dispatch,
 * restart, credential, DB, or Terminal ACK action is performed here.
 */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-phase3-package-ci-gate');
