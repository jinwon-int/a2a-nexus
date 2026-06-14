import { spawnSync } from 'node:child_process';

const steps = [
  ['layout', 'npm', ['run', 'check:layout']],
  ['contract-conformance-fixtures', 'npm', ['run', 'test:conformance']],
  ['packages', 'npm', ['run', 'check:packages']],
  ['runner-import-smoke', 'npm', ['run', 'check:runner-import-smoke']],
  ['terminal-brief-routing', 'npm', ['run', 'check:terminal-brief-routing']],
  ['message-id-ack-boundary', 'npm', ['run', 'check:message-id-ack-boundary']],
  ['external-harness-conformance', 'npm', ['run', 'check:external-harness-conformance']],
  ['public-readiness', 'npm', ['run', 'scan:public-readiness']],
  ['readiness-gates', 'npm', ['run', 'scan:readiness-gates']],
  ['external-secrets', 'npm', ['run', 'scan:external-secrets']],
  ['compatibility-baselines', 'node', ['scripts/check-compatibility-baselines.mjs']],
  ['repo-protection-baseline', 'node', ['scripts/check-repo-protection-baseline.mjs']],
  ['split-repo-local-demo', 'npm', ['run', 'check:split-repo-local-demo']],
  ['current-state-no-live-smoke', 'npm', ['run', 'check:current-state-no-live-smoke']],
  ['monorepo-reentry', 'npm', ['run', 'check:monorepo-reentry']],
  ['monorepo-import-rehearsal', 'npm', ['run', 'check:monorepo-import-rehearsal']],
  ['monorepo-ci-parity', 'npm', ['run', 'check:monorepo-ci-parity']],
  ['monorepo-phase3-package-ci-gate', 'npm', ['run', 'check:monorepo-phase3-package-ci-gate']],
  ['monorepo-package-ci-parity-jobs', 'npm', ['run', 'check:monorepo-package-ci-parity-jobs']],
  ['monorepo-canonical-flip-readiness', 'npm', ['run', 'check:monorepo-canonical-flip-readiness']],
  ['monorepo-branch-protection-approval-packet', 'npm', ['run', 'check:monorepo-branch-protection-approval-packet']],
  ['monorepo-split-repo-disposition-rollback', 'npm', ['run', 'check:monorepo-split-repo-disposition-rollback']],
  ['monorepo-split-repo-disposition-preflight', 'npm', ['run', 'check:monorepo-split-repo-disposition-preflight']],
  ['monorepo-active-provenance-mirror-execution-result', 'npm', ['run', 'check:monorepo-active-provenance-mirror-execution-result']],
  ['monorepo-release-package-tag-approval', 'npm', ['run', 'check:monorepo-release-package-tag-approval']],
  ['monorepo-final-operator-signoff', 'npm', ['run', 'check:monorepo-final-operator-signoff']],
  ['monorepo-canonical-source-flip-execution-handoff', 'npm', ['run', 'check:monorepo-canonical-source-flip-execution-handoff']],
  ['monorepo-actual-canonical-flip-execution-preflight', 'npm', ['run', 'check:monorepo-actual-canonical-flip-execution-preflight']],
  ['monorepo-actual-canonical-flip-execution-result', 'npm', ['run', 'check:monorepo-actual-canonical-flip-execution-result']],
  ['monorepo-operator-approval-handoff', 'npm', ['run', 'check:monorepo-operator-approval-handoff']],
  ['monorepo-docs-routing', 'npm', ['run', 'check:monorepo-docs-routing']],
  ['readme-canonical-surface', 'npm', ['run', 'check:readme-canonical-surface']],
  ['broker-core-dependency-isolation', 'npm', ['run', 'check:broker-core-dependency-isolation']],
  ['broker-docker-hardening', 'npm', ['run', 'check:broker-docker-hardening']],
  ['monorepo-branch-release-policy', 'npm', ['run', 'check:monorepo-branch-release-policy']],
];

for (const [name, command, args] of steps) {
  console.log(`release gate: ${name}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('release gate ok');
