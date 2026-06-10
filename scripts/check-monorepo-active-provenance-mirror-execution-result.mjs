#!/usr/bin/env node
/** Validate active provenance mirror execution result. */
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd(); const failures=[];
function fail(m){failures.push(m)} function expect(c,m){if(!c)fail(m)} function readRel(r){try{return fs.readFileSync(path.join(root,r),'utf8')}catch{return null}} function parseJson(r){const t=readRel(r); if(t===null){fail(`missing ${r}`);return null} try{return JSON.parse(t)}catch(e){fail(`${r}: invalid JSON: ${e instanceof Error?e.message:String(e)}`);return null}}
const fixture=parseJson('fixtures/current-state/monorepo-active-provenance-mirror-execution-result.json');
const doc=readRel('docs/monorepo-active-provenance-mirror-execution-result.md');
const currentState=readRel('docs/current-state.md');
const pkg=parseJson('package.json');
const releaseGate=readRel('scripts/release-gate.mjs')||'';
if(fixture){
 expect(fixture.schema==='a2a.monorepo-active-provenance-mirror-execution-result.v1','fixture: schema mismatch');
 expect(fixture.operatorApproval==='승인: split repo active provenance mirror execution 진행','fixture: approval phrase mismatch');
 expect(fixture.canonicalSourceState==='MONOREPO_PACKAGES_CANONICAL','fixture: canonical source state mismatch');
 expect(fixture.targetDisposition==='ACTIVE_PROVENANCE_MIRROR','fixture: target disposition mismatch');
 expect(fixture.actualDispositionExecution==='EXECUTED_DOCS_ONLY_ACTIVE_PROVENANCE_MIRROR','fixture: execution mismatch');
 expect(fixture.externalSettingsMutationPerformed===false,'fixture: settings mutation must be false');
 const repos=fixture.repositories||[]; expect(repos.length===3,'fixture: expected 3 split repos');
 for(const r of repos){expect(r.state==='ACTIVE_PROVENANCE_MIRROR',`fixture: ${r.repo} state mismatch`); for(const k of ['archived','readOnly','redirected','settingsMutated']) expect(r[k]===false,`fixture: ${r.repo} ${k} must be false`); for(const f of ['README.md','MIRROR_NOTICE.md']) expect((r.files||[]).includes(f),`fixture: ${r.repo} missing ${f}`); expect(/^https:\/\/github\.com\/jinwon-int\/.+\/pull\/\d+$/.test(r.pr),`fixture: bad PR URL for ${r.repo}`); expect(/^[0-9a-f]{40}$/.test(r.mergeCommit),`fixture: bad merge commit for ${r.repo}`)}
 const ev=fixture.a2adEvidence||{}; expect(ev.primaryRound==='a2ad-active-provenance-mirror-20260610T155109Z','fixture: primary round mismatch'); expect(ev.focusedTeam1RetryRound==='a2ad-active-provenance-mirror-team1-retry-20260610T155535Z','fixture: retry round mismatch'); expect(ev.usableAnalysisCount===6,'fixture: usable analysis count must be 6'); for(const w of ['sogyo','nosuk','bangtong','dungae','jingun','soonwook']) expect((ev.workers||[]).some(e=>e.worker===w && e.status==='succeeded' && e.analysisStatus==='done'),`fixture: missing done worker ${w}`);
 const gates=fixture.executionGates||{}; for(const k of ['operatorApprovalPhraseMatched','preflightPacketMerged','a2adEvidenceRecorded','splitRepoPrsMerged','mirrorNoticeFilesPresent','readmeBannersPresent','remoteBranchesDeleted','repoFactsVerifiedReadOnly']) expect(gates[k]===true,`fixture: gate ${k} must be true`); expect(gates.externalSettingsMutationPerformed===false,'fixture: external settings mutation false');
 const b=fixture.boundaries||{}; expect(b.docsOnlyMirrorNotice===true,'fixture: docsOnlyMirrorNotice true'); for(const [k,v] of Object.entries(b)) if(k!=='docsOnlyMirrorNotice') expect(v===false,`fixture: boundary ${k} must be false`);
 const g=fixture.goNoGoFields||{}; expect(g.activeProvenanceMirrorExecutionApproved===true,'fixture: execution approved true'); expect(g.activeProvenanceMirrorExecuted===true,'fixture: executed true'); for(const k of ['splitReposArchived','splitReposReadOnly','splitReposRedirected','repoSettingsMutated','packageOwnershipTransferred','releasePublishDeployApproved','externalLiveMutationPerformed']) expect(g[k]===false,`fixture: ${k} must be false`); expect(g.decision==='GO_EXECUTED_DOCS_ONLY_ACTIVE_PROVENANCE_MIRROR__EXTERNAL_SURFACES_HOLD','fixture: decision mismatch');
}
if(doc){for(const s of ['ACTIVE_PROVENANCE_MIRROR','a2a-broker#1364','a2a-docker-runner#373','plugin-a2a#466','No-live Boundary','Rollback']) expect(doc.includes(s),`doc: missing ${s}`)}
if(currentState){expect(/monorepo-active-provenance-mirror-execution-result\.md/.test(currentState),'current-state: missing active mirror execution link'); expect(/ACTIVE_PROVENANCE_MIRROR/.test(currentState),'current-state: missing active mirror status')}
if(pkg) expect(pkg.scripts?.['check:monorepo-active-provenance-mirror-execution-result']==='node scripts/check-monorepo-active-provenance-mirror-execution-result.mjs','package: missing check script');
expect(/monorepo-active-provenance-mirror-execution-result/.test(releaseGate),'release gate: missing active mirror execution result step');
if(failures.length){console.error(`active provenance mirror execution validation failed:\n- ${failures.join('\n- ')}`);process.exit(1)}
console.log('active provenance mirror execution result ok');
