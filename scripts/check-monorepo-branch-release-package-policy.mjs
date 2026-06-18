#!/usr/bin/env node
/**
 * Validate the #517 monorepo branch protection and release/package policy.
 *
 * Safety: source-only fixture/doc validation. No GitHub settings, release, package, image, visibility, canonical flip, live dispatch, restart, credential, DB, or Terminal ACK action.
 */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-branch-release-policy');
