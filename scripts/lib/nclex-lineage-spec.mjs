#!/usr/bin/env node
/**
 * NCLEX content PR → review-lineage spec (#2362, #2274/#2351 follow-up).
 *
 * One lineage per (nclex PR, reviewer role). A lineage models a single
 * reviewer stream (review-lifecycle/lifecycle.ts: the first clean `pass`
 * terminates it, later reports are `report_out_of_state`), so the parallel
 * role lanes of one NCLEX head (content_clinical, evidence_adversarial,
 * high_risk_safety) must never share a lineage.
 *
 * The frozen intent comes only from head-independent inputs: the PR number,
 * the role, and the PR body's 8-field contract block (TASK_ID … RISK_CLASS,
 * the same block nclex `tools/a2a_dispatch.js` hashes). NCLEX's own
 * per-head `intentContract` (schema nclex.exact-current-content-pr-intent.v1)
 * binds headSha into its hash and is left untouched — a new head after a
 * correction moves this lineage with `review-lineage-client.mjs correct`, it
 * never creates a new lineage.
 *
 * Pure and offline: no network, no GitHub, no broker. The output is a spec
 * for `scripts/lib/review-lineage-client.mjs create --spec`.
 *
 * usage: node scripts/lib/nclex-lineage-spec.mjs --pr N --role ROLE --base SHA --head SHA
 *          --body-file FILE (--repo DIR | --diff-file FILE)
 *          [--broker-url URL] [--requester-id ID] [--out FILE]
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { NCLEX_CONTENT_PR_PRESET_V1 } from "../nclex-content-pr-preset.mjs";

export const NCLEX_REPO = "jinwon-int/nclex";
export const PR_FIELD_ORDER = Object.freeze([
  "TASK_ID", "TASK_KIND", "AUTHOR_NODE", "TARGET_IDS",
  "SOURCE_PACKET", "REFS_MANIFEST_SHA256", "BASE_SHA", "RISK_CLASS",
]);

const presetBrief = (kind) => NCLEX_CONTENT_PR_PRESET_V1.lanes.find((lane) => lane.kind === kind).brief;

/** Role definitions. Briefs for the two standard roles come from the #1724 preset. */
export const NCLEX_LINEAGE_ROLES = Object.freeze({
  content_clinical: Object.freeze({
    brief: presetBrief("content_clinical"),
    acceptance: Object.freeze([
      "임상 내용이 현행 간호 표준과 근거 패킷에 맞고 사실 오류가 없다.",
      "문항이 선언한 NCJMM 단계와 문항 유형에 맞게 설계되어 있다.",
      "정답과 오답의 변별이 우선순위·위임·안전 원칙에 부합한다.",
      "해설(rationale)이 정답의 근거를 설명하고 결론을 지지한다.",
    ]),
  }),
  evidence_adversarial: Object.freeze({
    brief: presetBrief("evidence_adversarial"),
    acceptance: Object.freeze([
      "모든 주장이 근거 패킷의 자료 ID·해시·절/쪽 인용과 정합한다.",
      "라이선스·유사도 기준을 위반하지 않는다.",
      "문항 본문·선택지에 정답 단서 누출이 없다.",
      "응시자 화면·렌더링이 깨지지 않는다.",
      "PR의 gate 결과가 exact head에서 재현된다.",
    ]),
  }),
  high_risk_safety: Object.freeze({
    brief: "환자 위해로 이어질 수 있는 오류(투약 용량·경로·금기, 응급 우선순위, 안전 경고 누락)를 독립 검증한다. 위해 가능성이 남으면 BLOCK.",
    acceptance: Object.freeze([
      "투약 용량·경로·금기와 응급 우선순위에 위해 가능한 오류가 없다.",
      "필요한 안전 경고·주의 문구가 빠지거나 약화되지 않았다.",
      "학습자가 그대로 따랐을 때 환자 위해로 이어질 정답·해설이 없다.",
    ]),
  }),
});

const ROLES_BY_RISK = Object.freeze({
  standard: Object.freeze(["content_clinical", "evidence_adversarial"]),
  high: Object.freeze(["content_clinical", "evidence_adversarial", "high_risk_safety"]),
});

// NCLEX content PRs touch only the catalog, data, and refs trees (observed on
// #502/#611/#612/#624). Gate tooling and CI are forbidden for a content PR.
export const NCLEX_DECLARED_PATHS = Object.freeze({
  allowed: Object.freeze(["content/**", "data/**", "refs/**"]),
  forbidden: Object.freeze([".github/**", "tools/**", "schema/**"]),
});

const SHA40 = /^[0-9a-f]{40}$/;

export class NclexLineageSpecError extends Error {
  constructor(message) {
    super(message);
    this.name = "NclexLineageSpecError";
  }
}

function fail(message) {
  throw new NclexLineageSpecError(message);
}

/**
 * Remove HTML comments without a regex: repeat until stable so a comment
 * reassembled by an inner removal (`<!<!---->--`) is removed too, and drop an
 * unterminated `<!--` through the end of the value.
 */
export function stripHtmlComments(text) {
  let current = String(text);
  for (;;) {
    let out = "";
    let index = 0;
    while (index < current.length) {
      const start = current.indexOf("<!--", index);
      if (start < 0) { out += current.slice(index); break; }
      out += current.slice(index, start);
      const end = current.indexOf("-->", start + 4);
      if (end < 0) break;
      index = end + 3;
    }
    if (out === current) return out;
    current = out;
  }
}

/** Same line grammar as nclex `tools/content_process.js` parsePrFields: `- KEY: value`. */
export function parsePrFields(body) {
  const fields = {};
  for (const line of String(body ?? "").split("\n")) {
    const match = line.match(/^\s*-\s*([A-Z0-9_]+):\s*(.*?)\s*$/);
    if (match) fields[match[1]] = stripHtmlComments(match[2]).trim();
  }
  return fields;
}

function prNumberOf(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]{0,6}$/.test(text)) fail("prNumber must be a positive integer");
  return Number(text);
}

/** Deterministic id so a correction round finds the same lineage again. */
export function nclexLineageId(prNumber, role) {
  if (!Object.hasOwn(NCLEX_LINEAGE_ROLES, role)) fail(`unknown role ${role}`);
  return `nclex-pr${prNumberOf(prNumber)}-${role.replaceAll("_", "-")}`;
}

/**
 * Build a review-lineage-client create spec for one (PR, role).
 * Exactly one of `repo` (checkout containing both commits) or `diffFile`.
 */
export function buildNclexLineageSpec({
  prNumber,
  role,
  prBody,
  baseSha,
  headSha,
  repo,
  diffFile,
  brokerUrl,
  requesterId,
} = {}) {
  const pr = prNumberOf(prNumber);
  if (!Object.hasOwn(NCLEX_LINEAGE_ROLES, role)) fail(`unknown role ${role}`);
  if (!SHA40.test(baseSha ?? "")) fail("baseSha must be a 40-char lowercase SHA");
  if (!SHA40.test(headSha ?? "")) fail("headSha must be a 40-char lowercase SHA");
  if ((repo === undefined) === (diffFile === undefined)) fail("exactly one of repo or diffFile is required");

  const fields = parsePrFields(prBody);
  for (const key of PR_FIELD_ORDER) {
    if (!fields[key]) fail(`PR body is missing required field ${key}`);
  }
  const roles = ROLES_BY_RISK[fields.RISK_CLASS];
  if (!roles) fail(`unsupported RISK_CLASS ${fields.RISK_CLASS}`);
  if (!roles.includes(role)) fail(`role ${role} is not a lane for RISK_CLASS ${fields.RISK_CLASS}`);

  const def = NCLEX_LINEAGE_ROLES[role];
  const otherRoles = roles.filter((other) => other !== role);
  const spec = {
    lineageId: nclexLineageId(pr, role),
    dispatchRef: `nclex:pr${pr}:${fields.TASK_ID}:${role}`,
    goal: `${NCLEX_REPO} PR #${pr} ${fields.TASK_KIND} ${fields.TASK_ID} (${fields.TARGET_IDS}) — ${role} 리뷰: ${def.brief}`,
    nonGoals: [
      ...otherRoles.map((other) => `${other} 역할의 판정 범위`),
      "카탈로그·data·refs 밖의 앱·도구·CI 변경 평가",
      "PR 브랜치 수정, 머지, GitHub 게시",
    ],
    invariants: [
      "read-only 리뷰: mutation, GitHub write, live action 없음",
      `근거 패킷 ${fields.SOURCE_PACKET}와 refs manifest sha256 ${fields.REFS_MANIFEST_SHA256}에만 근거한다`,
      `작성자 ${fields.AUTHOR_NODE}는 리뷰어에서 제척된다`,
      `RISK_CLASS ${fields.RISK_CLASS}의 역할 레인(${roles.join(", ")})은 각각 별도 lineage다`,
    ],
    acceptanceCriteria: def.acceptance.map((text, index) => ({ id: `AC-${index + 1}`, text })),
    declaredPaths: {
      allowed: [...NCLEX_DECLARED_PATHS.allowed],
      forbidden: [...NCLEX_DECLARED_PATHS.forbidden],
    },
    baseSha,
    headSha,
  };
  if (repo !== undefined) spec.repo = repo;
  else spec.diffFile = diffFile;
  if (brokerUrl !== undefined) spec.brokerUrl = brokerUrl;
  if (requesterId !== undefined) spec.requesterId = requesterId;
  return spec;
}

const USAGE = "usage: node scripts/lib/nclex-lineage-spec.mjs --pr N --role ROLE --base SHA --head SHA --body-file FILE (--repo DIR | --diff-file FILE) [--broker-url URL] [--requester-id ID] [--out FILE]";

export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        pr: { type: "string" }, role: { type: "string" }, base: { type: "string" }, head: { type: "string" },
        "body-file": { type: "string" }, repo: { type: "string" }, "diff-file": { type: "string" },
        "broker-url": { type: "string" }, "requester-id": { type: "string" }, out: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (!values.pr || !values.role || !values.base || !values.head || !values["body-file"]) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const spec = buildNclexLineageSpec({
      prNumber: values.pr,
      role: values.role,
      prBody: fs.readFileSync(values["body-file"], "utf8"),
      baseSha: values.base,
      headSha: values.head,
      repo: values.repo,
      diffFile: values["diff-file"],
      brokerUrl: values["broker-url"],
      requesterId: values["requester-id"],
    });
    const text = `${JSON.stringify(spec, null, 2)}\n`;
    if (values.out) fs.writeFileSync(values.out, text, { mode: 0o600 });
    else stdout.write(text);
    return 0;
  } catch (error) {
    stderr.write(`nclex-lineage-spec: ${error.message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
