#!/usr/bin/env node
/** Validate the actual canonical flip execution preflight packet. Source-only. */
import { createDocCheckContext } from './lib/doc-check.mjs';
const { root, failures, fail, expect, readRel, parseJson } = createDocCheckContext();
const fixture=parseJson('fixtures/current-state/monorepo-actual-canonical-flip-execution-preflight.json');
const doc=readRel('docs/monorepo-actual-canonical-flip-execution-preflight.md');
const currentState=readRel('docs/current-state.md');
const pkg=parseJson('package.json');
const releaseGate=readRel('scripts/release-gate.mjs')||'';
expect(doc!==null,'missing preflight doc');
if(fixture){
 expect(fixture.schema==='a2a.monorepo-actual-canonical-flip-execution-preflight.v1','fixture: schema mismatch');
 expect(fixture.tracker==='https://github.com/jinwon-int/a2a-nexus/issues/553','fixture: tracker mismatch');
 expect(fixture.sourceCommit==='551a97825697525077ce38777383298c0d775d2d','fixture: source commit mismatch');
 expect(fixture.priorPackets?.executionHandoff==='https://github.com/jinwon-int/a2a-nexus/pull/568','fixture: prior handoff must be PR #568');
 expect(fixture.preflightDecision==='GO_PR_FIRST_SOURCE_ONLY_PREFLIGHT','fixture: preflight decision mismatch');
 expect(fixture.actualExecutionAuthorization==='NO_GO_WAITING_EXPLICIT_FINAL_APPROVAL_REQUIRED','fixture: actual execution must be NO_GO');
 for(const p of ['packages/broker','packages/docker-runner','packages/openclaw-plugin-a2a']) expect((fixture.canonicalSourceCandidates||[]).includes(p),`fixture: missing candidate ${p}`);
 expect(fixture.activeRuleset?.id===17499616,'fixture: ruleset id mismatch');
 expect(fixture.activeRuleset?.enforcement==='active','fixture: ruleset must be active');
 for(const c of ['paths-filter','setup','layout','contracts','check']) expect((fixture.activeRuleset?.requiredStatusChecks||[]).includes(c),`fixture: missing required check ${c}`);
 const ev=fixture.a2aEvidence||{};
 expect(ev.primaryRound==='a2a-actualflip-preflight-20260610T135405Z','fixture: primary round mismatch');
 expect(ev.supplementalRound==='a2a-actualflip-team1-retry-20260610T135812Z','fixture: supplemental round mismatch');
 expect(ev.usableAnalysisCount>=6,'fixture: must record six usable analyses');
 for(const w of ['sogyo','nosuk','bangtong','dungae','jingun','soonwook']) expect((ev.workers||[]).some(e=>e.worker===w && e.status==='succeeded'),`fixture: missing worker ${w}`);
 expect((ev.team1UsableWorkers||[]).length===3,'fixture: Team1 must have three usable workers');
 expect((ev.team2UsableWorkers||[]).length===3,'fixture: Team2 must have three usable workers');
 const gates=fixture.preflightGates||{};
 for(const k of ['sourceCommitPinned','activeRulesetPinned','requiredChecksPinned','requiredReviewPinned','a2aEvidenceRecorded','rollbackAbortPolicyRecorded','noLiveBoundaryRecorded']) expect(gates[k]===true,`fixture: gate ${k} must be true`);
 for(const k of ['finalExecutionApprovalPresent','executionRunStarted','stateMutationPerformed']) expect(gates[k]===false,`fixture: gate ${k} must be false`);
 for(const f of ['github_settings_mutation','split_repo_archive_readonly_redirect','package_ownership_transfer','release_tag_or_github_release','npm_publish','docker_ghcr_publish','deploy_restart','db_mutation_or_replay','secret_or_credential_movement','provider_or_telegram_send','terminal_ack_or_replay']) expect((fixture.executionRunbook?.forbiddenUntilFinalApproval||[]).includes(f),`fixture: missing forbidden ${f}`);
 expect(fixture.executionRunbook?.finalApprovalRequiredText==='승인: actual canonical flip execution 진행','fixture: final approval text mismatch');
 expect(/normal PR revert/.test(fixture.rollbackPolicy?.preExecutionRollback||''),'fixture: pre-execution rollback must be PR revert');
 expect(Array.isArray(fixture.rollbackPolicy?.abortIf) && fixture.rollbackPolicy.abortIf.length>=5,'fixture: abort criteria required');
 const b=fixture.boundaries||{}; expect(b.sourceOnly===true,'fixture: sourceOnly true'); for(const [k,v] of Object.entries(b)) if(k!=='sourceOnly') expect(v===false,`fixture: boundary ${k} must be false`);
 const g=fixture.goNoGoFields||{}; expect(g.preflightPacketAllowed===true,'fixture: preflight allowed'); expect(g.actualCanonicalFlipExecutionApproved===false,'fixture: execution not approved'); expect(g.finalApprovalRequired===true,'fixture: final approval required'); expect(g.decision==='GO_PR_FIRST_SOURCE_ONLY_PREFLIGHT__EXECUTION_NO_GO_WAITING','fixture: decision mismatch');
}
if(doc){for(const p of ['GO_PR_FIRST_SOURCE_ONLY_PREFLIGHT','NO_GO / Waiting','finalApprovalRequiredText','A2A Evidence','Forbidden Until Final Approval','Rollback / Abort Policy','No-live Boundary']) expect(doc.includes(p),`doc: missing ${p}`)}
if(currentState){expect(/monorepo-actual-canonical-flip-execution-preflight\.md/.test(currentState),'current-state: missing preflight doc link'); expect(/GO_PR_FIRST_SOURCE_ONLY_PREFLIGHT/.test(currentState),'current-state: missing preflight decision')}
if(pkg) expect(pkg.scripts?.['check:monorepo-actual-canonical-flip-execution-preflight']==='node scripts/check-monorepo-actual-canonical-flip-execution-preflight.mjs','package: missing preflight check');
expect(/monorepo-actual-canonical-flip-execution-preflight/.test(releaseGate),'release gate: missing preflight step');
if(failures.length){console.error(`actual canonical flip execution preflight validation failed:\n- ${failures.join('\n- ')}`);process.exit(1)}
console.log('actual canonical flip execution preflight ok');
