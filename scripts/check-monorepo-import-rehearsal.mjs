#!/usr/bin/env node
/**
 * Validate the #513 monorepo import rehearsal packet.
 *
 * Safety: source-only fixture/doc validation. No import, history rewrite,
 * release, publish, visibility, live dispatch, restart, credential, DB, or
 * Terminal ACK action is performed here.
 */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-import-rehearsal');
