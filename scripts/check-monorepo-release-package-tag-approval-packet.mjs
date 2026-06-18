#!/usr/bin/env node
/**
 * Validate the #547 release/package/tag approval packet.
 *
 * Safety: source-only fixture/doc validation. No tag, GitHub Release, npm, Docker/GHCR, package ownership, canonical flip, split repo disposition, deploy, restart, credential, DB, provider send, or Terminal ACK action.
 */
import { runDocSpecCheck } from './lib/doc-spec-check.mjs';

runDocSpecCheck('monorepo-release-package-tag-approval');
