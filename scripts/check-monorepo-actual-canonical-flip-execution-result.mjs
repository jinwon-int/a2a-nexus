#!/usr/bin/env node
/** Validate actual canonical flip execution result. */
import { createDocCheckContext } from './lib/doc-check.mjs';
const { root, failures, fail, expect, readRel, parseJson } = createDocCheckContext();
const fixture=parseJson('fixtures/current-state/monorepo-actual-canonical-flip-execution-result.json');
const doc=readRel('docs/monorepo-actual-canonical-flip-execution-result.md');
const currentState=readRel('docs/current-state.md');
const pkg=parseJson('package.json');
const releaseGate=readRel('scripts/release-gate.mjs')||'';
if(fixture){
 expect(fixture.schema==='a2a.monorepo-actual-canonical-flip-execution-result.v1','fixture: schema mismatch');
 expect(fixture.operatorApproval==='승인: actual canonical flip execution 진행','fixture: approval phrase mismatch');
 expect(fixture.actualCanonicalFlipExecution==='EXECUTED_SOURCE_STATE_ONLY','fixture: execution must be source-state executed');
 expect(fixture.canonicalSourceState==='MONOREPO_PACKAGES_CANONICAL','fixture: canonical state mismatch');
 expect(fixture.executionOwner==='seoseo finalizer/operator','fixture: execution owner mismatch');
 expect(/seoseo finalizer\/operator/.test(fixture.rollbackOwner||''),'fixture: rollback owner must be seoseo finalizer/operator');
 for(const p of ['https://github.com/jinwon-int/a2a-nexus/pull/567','https://github.com/jinwon-int/a2a-nexus/pull/568','https://github.com/jinwon-int/a2a-nexus/pull/569']) expect(Object.values(fixture.priorPackets||{}).includes(p),`fixture: missing prior packet ${p}`);
 const paths=(fixture.canonicalSources||[]).map(s=>s.canonicalPath).sort();
 for(const p of ['packages/broker','packages/docker-runner','packages/openclaw-plugin-a2a']) expect(paths.includes(p),`fixture: missing canonical path ${p}`);
 for(const s of fixture.canonicalSources||[]){expect(s.state==='canonical_source',`fixture: ${s.canonicalPath} must be canonical_source`); expect(s.packageOwnershipTransferred===false,`fixture: ${s.canonicalPath} ownership transfer must be false`); expect(/not_archived_not_readonly_not_redirected/.test(s.externalRepoDisposition||''),`fixture: ${s.canonicalPath} external disposition must remain unchanged`)}
 const ev=fixture.a2adEvidence||{}; expect(ev.primaryRound==='a2ad-actualflip-exec-retry-20260610T143021Z','fixture: primary A2AD round mismatch'); expect(ev.supplementalSogyoRound==='a2ad-actualflip-sogyo-retry-20260610T143538Z','fixture: Sogyo retry round mismatch'); expect(ev.usableAnalysisCount>=6,'fixture: must record six usable A2AD analyses'); for(const w of ['sogyo','nosuk','bangtong','dungae','jingun','soonwook']) expect((ev.workers||[]).some(e=>e.worker===w && e.status==='succeeded' && e.analysisStatus==='done'),`fixture: missing done worker ${w}`);
 const gates=fixture.executionGates||{}; for(const k of ['operatorApprovalPhraseMatched','scopeBoundToSourceStateOnly','executionOwnerAssigned','rollbackOwnerAssigned','a2adEvidenceRecorded','preflightPacketMerged','requiredReviewStillRequired','requiredChecksStillRequired','actualCanonicalFlipSourceStateExecuted']) expect(gates[k]===true,`fixture: gate ${k} must be true`); expect(gates.externalMutationPerformed===false,'fixture: external mutation must be false');
 const b=fixture.boundaries||{}; expect(b.sourceStateCanonicalFlip===true,'fixture: sourceStateCanonicalFlip must be true'); for(const [k,v] of Object.entries(b)) if(k!=='sourceStateCanonicalFlip') expect(v===false,`fixture: boundary ${k} must be false`);
 const g=fixture.goNoGoFields||{}; expect(g.actualCanonicalFlipExecutionApproved===true,'fixture: actual execution approved'); expect(g.actualCanonicalFlipSourceStateExecuted===true,'fixture: actual source-state executed'); expect(g.monorepoPackagesCanonicalSource===true,'fixture: monorepo packages canonical'); for(const k of ['splitRepoDispositionExecuted','packageOwnershipTransferred','releasePublishDeployApproved','settingsMutationApproved','externalLiveMutationPerformed']) expect(g[k]===false,`fixture: ${k} must remain false`); expect(g.decision==='GO_EXECUTED_SOURCE_STATE_ONLY__EXTERNAL_SURFACES_HOLD','fixture: decision mismatch');
}
if(doc){for(const s of ['EXECUTED_SOURCE_STATE_ONLY','MONOREPO_PACKAGES_CANONICAL','packages/broker','packages/docker-runner','packages/openclaw-plugin-a2a','Remaining Separate Approvals','No-live / No-external-mutation Boundary']) expect(doc.includes(s),`doc: missing ${s}`)}
if(currentState){expect(/monorepo-actual-canonical-flip-execution-result\.md/.test(currentState),'current-state: missing execution result link'); expect(/MONOREPO_PACKAGES_CANONICAL/.test(currentState),'current-state: missing canonical source state'); expect(/source-state-only actual canonical flip execution has been performed/.test(currentState),'current-state: missing execution wording')}
if(pkg) expect(pkg.scripts?.['check:monorepo-actual-canonical-flip-execution-result']==='node scripts/check-monorepo-actual-canonical-flip-execution-result.mjs','package: missing execution result check');
expect(/monorepo-actual-canonical-flip-execution-result/.test(releaseGate),'release gate: missing execution result step');
if(failures.length){console.error(`actual canonical flip execution result validation failed:\n- ${failures.join('\n- ')}`);process.exit(1)}
console.log('actual canonical flip execution result ok');
