#!/usr/bin/env node
/** Validate split-repo disposition preflight. */
import { createDocCheckContext } from './lib/doc-check.mjs';
const { root, failures, fail, expect, readRel, parseJson } = createDocCheckContext();
const fixture=parseJson('fixtures/current-state/monorepo-split-repo-disposition-preflight.json');
const doc=readRel('docs/monorepo-split-repo-disposition-preflight.md');
const currentState=readRel('docs/current-state.md');
const pkg=parseJson('package.json');
const releaseGate=readRel('scripts/release-gate.mjs')||'';
if(fixture){
 expect(fixture.schema==='a2a.monorepo-split-repo-disposition-preflight.v1','fixture: schema mismatch');
 expect(fixture.operatorApproval==='승인: split repo disposition preflight 진행','fixture: approval phrase mismatch');
 expect(fixture.preflightDecision==='GO_PR_FIRST_SOURCE_ONLY_PREFLIGHT','fixture: preflight decision mismatch');
 expect(fixture.canonicalSourceState==='MONOREPO_PACKAGES_CANONICAL','fixture: canonical source state mismatch');
 expect(fixture.actualDispositionExecution==='NO_GO_WAITING_SEPARATE_APPROVAL_REQUIRED','fixture: actual disposition must remain NO_GO');
 expect(fixture.futureCandidateDisposition==='ACTIVE_PROVENANCE_MIRROR','fixture: candidate disposition mismatch');
 for(const x of ['read_only_archive','archived_redirect']) expect((fixture.explicitNonCandidates||[]).includes(x),`fixture: missing non-candidate ${x}`);
 const repos=fixture.repositories||[]; for(const p of ['packages/broker','packages/docker-runner','packages/openclaw-plugin-a2a']) expect(repos.some(r=>r.canonicalPath===p),`fixture: missing repo path ${p}`);
 for(const r of repos){expect(r.currentExternalDisposition==='active_public_unarchived',`fixture: ${r.repo} current external state mismatch`); expect(r.canonicalRoleAfterFlip==='non_canonical_provenance_source',`fixture: ${r.repo} canonical role mismatch`); expect(r.futureCandidateDisposition==='active_provenance_mirror',`fixture: ${r.repo} candidate mismatch`); expect(r.archiveReadOnlyRedirectApproved===false,`fixture: ${r.repo} archive/read-only/redirect must be false`); expect(r.settingsMutationApproved===false,`fixture: ${r.repo} settings mutation must be false`)}
 expect(/openclaw-plugin-a2a resolves to jinwon-int\/plugin-a2a/.test(fixture.repoFactsReadOnly?.deduplicationCheck||''),'fixture: plugin alias dedupe must be recorded');
 const ev=fixture.a2adEvidence||{}; expect(ev.primaryRound==='a2ad-splitdispo-preflight-20260610T150452Z','fixture: A2AD round mismatch'); expect(ev.usableAnalysisCount>=6,'fixture: must record six usable analyses'); for(const w of ['sogyo','nosuk','bangtong','dungae','jingun','soonwook']) expect((ev.workers||[]).some(e=>e.worker===w && e.status==='succeeded' && e.analysisStatus==='done'),`fixture: missing done worker ${w}`);
 const gates=fixture.preflightGates||{}; for(const k of ['operatorApprovalPhraseMatched','canonicalSourceFlipResultMerged','repoFactsReadOnlyCaptured','pluginAliasDeduped','rollbackOwnerFieldsRecorded','communicationPlanRequired','emergencyHotfixFallbackRequired','futureExecutionApprovalRequired','preflightOnly']) expect(gates[k]===true,`fixture: gate ${k} must be true`); expect(gates.externalRepoMutationPerformed===false,'fixture: external repo mutation must be false');
 const b=fixture.boundaries||{}; expect(b.sourceOnlyPreflight===true,'fixture: sourceOnlyPreflight true'); for(const [k,v] of Object.entries(b)) if(k!=='sourceOnlyPreflight') expect(v===false,`fixture: boundary ${k} must be false`);
 const g=fixture.goNoGoFields||{}; expect(g.preflightAllowed===true,'fixture: preflight allowed'); expect(g.activeProvenanceMirrorCandidateRecorded===true,'fixture: candidate recorded'); for(const k of ['actualSplitRepoDispositionApproved','readOnlyArchiveApproved','archivedRedirectApproved','repoSettingsMutationApproved','packageOwnershipTransferred','externalLiveMutationPerformed']) expect(g[k]===false,`fixture: ${k} must remain false`); expect(g.decision==='GO_PR_FIRST_SOURCE_ONLY_PREFLIGHT__DISPOSITION_EXECUTION_HOLD','fixture: decision mismatch');
}
if(doc){for(const s of ['ACTIVE_PROVENANCE_MIRROR','NO_GO / Waiting','Future Execution Requirements','No-live Boundary','plugin-a2a']) expect(doc.includes(s),`doc: missing ${s}`)}
if(currentState){expect(/monorepo-split-repo-disposition-preflight\.md/.test(currentState),'current-state: missing split disposition preflight link'); expect(/ACTIVE_PROVENANCE_MIRROR/.test(currentState),'current-state: missing active provenance mirror candidate')}
if(pkg) expect(pkg.scripts?.['check:monorepo-split-repo-disposition-preflight']==='node scripts/check-monorepo-split-repo-disposition-preflight.mjs','package: missing split disposition preflight check');
expect(/monorepo-split-repo-disposition-preflight/.test(releaseGate),'release gate: missing split disposition preflight step');
if(failures.length){console.error(`split repo disposition preflight validation failed:\n- ${failures.join('\n- ')}`);process.exit(1)}
console.log('split repo disposition preflight ok');
