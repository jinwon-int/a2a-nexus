#!/usr/bin/env node
/**
 * Validate the #515 monorepo docs, CODEOWNERS, and issue-routing packet.
 *
 * Safety: source-only fixture/doc validation. No issue transfer, repository archive, visibility, release, canonical flip, live dispatch, restart, credential, DB, or Terminal ACK action.
 */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-docs-routing');
