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
<<<<<<< HEAD
=======
  ['repo-protection-baseline', 'node', ['scripts/check-repo-protection-baseline.mjs']],
>>>>>>> 93945c9 (Add repo protection baseline for A2A repos (#488))
];

for (const [name, command, args] of steps) {
  console.log(`release gate: ${name}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('release gate ok');
