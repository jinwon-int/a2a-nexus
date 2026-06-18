#!/usr/bin/env node
/**
 * Validate the #511 monorepo re-entry decision packet.
 *
 * Safety: source-only fixture/doc validation. No repo import, history rewrite,
 * release, publish, visibility, live dispatch, restart, credential, DB, or
 * Terminal ACK action is performed here.
 */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-reentry');
