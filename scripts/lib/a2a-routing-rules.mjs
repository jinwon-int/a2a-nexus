/**
 * A2A deterministic routing-rules baseline — pure, synchronous, offline
 * natural-language rule classifier (#2196, slice 3).
 *
 * This module ACTUALLY classifies `requestText` with declared conservative
 * rules: given a valid `a2a.routing-input.v1` input it returns a closed
 * `a2a.routing-advice.v1` advice (`recommend` / `not_a2a` / `defer`). It is
 * NOT a wrapper accepting caller-supplied desired labels and NOT a lookup of
 * development corpus ids/texts.
 *
 * Boundaries:
 *   - Reuses the frozen foundation library `./a2a-routing-advice.mjs` for
 *     input validation (`validateRoutingInput`), output validation
 *     (`validateRoutingAdviceOutput`, `expectedModelVersion =
 *     ROUTING_RULES_MODEL_VERSION`, `policyVersion = ROUTING_POLICY_VERSION`)
 *     and the trusted-context eligibility gate (`isRecommendationEligible`).
 *     No contract rule from the foundation is reimplemented here.
 *   - Only narrow, declared Korean/English phrasing families are recognized.
 *     This is NOT general natural-language understanding: unsupported or
 *     ambiguous phrasing conservatively defers. The rule ordering and the
 *     complete support surface are documented in
 *     docs/specs/a2a-routing-classifier/spec.md (rules baseline slice).
 *   - Trusted host context is caller-owned. Text claiming approval, write
 *     access, readiness or authorization can never change host flags; the
 *     only eligibility surface is the frozen foundation gate.
 *   - Purity: zero I/O of any kind (no filesystem, network, process or clock
 *     effect), fully synchronous, deterministic, no module state that
 *     survives a call, no model/provider/worker invocation, and no
 *     prepare/dispatch call of any kind. The development corpus is never
 *     imported, read, or tabulated here.
 *   - Plain JSON boundary: behavior is defined for plain JSON data only; this
 *     is not a getter/proxy sandbox and evaluates no code.
 *   - A `defer` here is a SEMANTIC outcome of the rules, never a provider
 *     failure or timeout (the frozen reason enum has no such code). The
 *     adapter process/timeout envelope is a separately specified future
 *     boundary and is deliberately absent from this module.
 *   - Error results use stable codes with generic fixed messages; they never
 *     echo request text, unknown field names, or identifier values.
 *     Foundation errors are returned without argument spreading;
 *     this module performs no unbounded argument spread.
 *
 * Rule ordering, preprocessing and support limits:
 * docs/specs/a2a-routing-classifier/spec.md (rules baseline slice #2196).
 * Exercised offline by scripts/lib/a2a-routing-rules.test.mjs. Nothing here
 * is deployed or wired into live routing; no accuracy/quality/speed claim is
 * made anywhere.
 */

import {
  MAX_REQUEST_TEXT_CODEPOINTS,
  ROUTING_ADVICE_SCHEMA_VERSION,
  ROUTING_POLICY_VERSION,
  ROUTING_TEMPLATE_IDS,
  isRecommendationEligible,
  validateRoutingAdviceOutput,
  validateRoutingInput,
} from './a2a-routing-advice.mjs';

// ─── Versioned contract constants ───────────────────────────────────────────

/** Versioned model identifier stamped on every advice this module produces. */
export const ROUTING_RULES_MODEL_VERSION = 'a2a.routing-rules.v1';

// ─── Small pure helpers ──────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function frozenError(code, path, message) {
  return Object.freeze({ code, path, message });
}

function fail(errors) {
  return { ok: false, errors };
}

/**
 * Deterministic bounded normalization: NFKC → lower-case → collapse
 * whitespace runs → trim. If normalization expands beyond the 4000-codepoint bound,
 * defer without truncation: discarding a suffix could remove a prohibition.
 * No locale-dependent casing.
 */
function normalizeForRules(text) {
  let s = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const cps = [...s];
  if (cps.length > MAX_REQUEST_TEXT_CODEPOINTS) {
    return null;
  }
  return s;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * Mask quoted regions (fenced code blocks, backtick pairs, straight and
 * curly quote pairs, corner brackets) so that commands occurring only inside
 * quotes never trigger a positive action. An ASCII apostrophe between Latin
 * letters (a contraction like "don't") is not a quote delimiter.
 *
 * Returns `{ text, hasQuotes, balanced }` where `text` is the unmasked
 * remainder with whitespace runs collapsed, `hasQuotes` reports whether any
 * region was masked, and `balanced` is false when any quote/fence marker
 * count is odd (malformed quoting → the caller conservatively defers).
 */
function maskQuotedSegments(text) {
  const chars = [...text];
  const n = chars.length;
  const masked = new Array(n).fill(false);
  let balanced = true;

  const maskRange = (a, b) => {
    for (let i = Math.max(0, a); i <= Math.min(b, n - 1); i += 1) masked[i] = true;
  };

  // Fenced code blocks: pair ``` markers in order.
  const fencePositions = [];
  for (let i = 0; i + 2 < n; i += 1) {
    if (chars[i] === '`' && chars[i + 1] === '`' && chars[i + 2] === '`') {
      fencePositions.push(i);
      i += 2;
    }
  }
  if (fencePositions.length % 2 !== 0) balanced = false;
  for (let p = 0; p + 1 < fencePositions.length; p += 2) {
    maskRange(fencePositions[p], fencePositions[p + 1] + 2);
  }

  const isLatinLetterOrDigit = (c) => /[a-z0-9]/.test(c);

  // Pair quote markers in order and mask each closed region. An odd marker
  // count marks the whole text as malformed quoting (never guessed through).
  const maskPairs = (positions) => {
    if (positions.length % 2 !== 0) balanced = false;
    for (let p = 0; p + 1 < positions.length; p += 2) {
      maskRange(positions[p], positions[p + 1]);
    }
  };

  const collectStraight = (marker) => {
    const positions = [];
    for (let i = 0; i < n; i += 1) {
      if (masked[i] || chars[i] !== marker) continue;
      if (marker === "'") {
        // Contraction guard: an apostrophe between two Latin letters/digits
        // (don't, it's, tutorial's) is not a quote boundary.
        const prev = i > 0 ? chars[i - 1] : '';
        const next = i + 1 < n ? chars[i + 1] : '';
        if (isLatinLetterOrDigit(prev) && isLatinLetterOrDigit(next)) continue;
      }
      positions.push(i);
    }
    return positions;
  };

  const collectDirectional = (open, close) => {
    const positions = [];
    for (let i = 0; i < n; i += 1) {
      if (masked[i]) continue;
      if (chars[i] === open || chars[i] === close) positions.push(i);
    }
    return positions;
  };

  // Inline backtick pairs (outside already-masked fence regions).
  const backticks = [];
  for (let i = 0; i < n; i += 1) {
    if (chars[i] === '`' && !masked[i]) backticks.push(i);
  }
  maskPairs(backticks);
  maskPairs(collectStraight('"'));
  maskPairs(collectStraight("'"));
  maskPairs(collectDirectional('‘', '’'));
  maskPairs(collectDirectional('“', '”'));
  maskPairs(collectDirectional('「', '」'));

  const kept = [];
  for (let i = 0; i < n; i += 1) kept.push(masked[i] ? ' ' : chars[i]);
  return {
    text: kept.join('').replace(/\s+/g, ' ').trim(),
    hasQuotes: masked.some(Boolean),
    balanced,
  };
}

// ─── Declared rule vocabulary (the complete support surface) ────────────────
// Every pattern below is a flat alternation of literals/stems with bounded
// {0,N} windows — no nested quantifiers, so no catastrophic backtracking.

// Docs scope: documentation objects (NOT bare 안내, which also means "hint").
const DOCS_SCOPE = new RegExp(
  '(문서|매뉴얼|메뉴얼|안내서|가이드|튜토리얼|용어집|레퍼런스|퀵스타트'
  + '|docs\\b|documentation|documents?\\b|readme\\b|guides?\\b|tutorials?\\b|glossar\\w*|\\breferences?\\b|manuals?\\b|faqs?\\b|changelog|quickstarts?)',
);

// Write/modify actions (패치 excludes 패치노트 "patch notes" lookalikes).
const WRITE_VERB = new RegExp(
  '(수정|고쳐|고치는|고칠|고쳐야|패치(?!노트)|해결|업데이트|갱신|교체|대체|덮어쓰기'
  + '|\\bfix(?:es|ed)?\\b|\\bpatch(?!ing)\\b|\\brepair\\b|\\bresolve\\b|\\bcorrect(?:ed|ion)?\\b'
  + '|\\bupdate[sd]?\\b|\\breplace[sd]?\\b|\\boverwrit\\w*)',
);

// Negated write action: removes write intents ("read/review only, do not
// modify" still permits the requested read template). Deliberately does NOT
// include "touch" — "do not touch the docs" is scope exclusion, not write
// exclusion of the code fix.
const WRITE_NEGATED = new RegExp(
  '(수정|편집|변경|작성|쓰기)[^ .]{0,3}(없이|말고|금지)|수정 ?하지 ?말고|(없이|말고) ?(수정|편집|변경)'
  + '|\\b(?:without|no|don.t|do not)\\b[^.]{0,14}\\b(?:edit|edits|editing|modify|modifying|modifications?|change[sd]?|changing|writ\\w*)\\b',
);

// Docs scope excluded/ excluded docs ("fix the bug but do not touch the
// docs" stays new_patch; "docs only, no code changes" stays docs_patch).
const DOCS_NEGATED = new RegExp(
  '(문서|매뉴얼|메뉴얼|안내서|가이드|튜토리얼|용어집|레퍼런스|docs|documentation|readme|guides?|tutorial|glossary|references?|manuals?|faqs?)'
  + '[^.]{0,16}(제외|빼고|말고|금지|건드리지|쓰지|수정하지|범위 ?밖)'
  + '|(제외|빼고|건드리지 ?말고|수정하지 ?말고|범위 ?밖'
  + '|\\bskip\\b|\\bexcept\\b|\\bexclud\\w*\\b|\\bdon.t touch\\b|\\bdo not touch\\b|\\buntouched\\b|\\bout of scope\\b)'
  + '[^.]{0,18}(문서|docs\\b|documentation|readme\\b|guides?\\b|tutorial|manuals?\\b|faqs?\\b)',
);

// Code object written/modified near a write action (docs+code compound asks).
const CODE_WRITE = new RegExp(
  '(코드|code)[^.]{0,24}(수정|고쳐|고치|패치|바꾸|fix|patch|update|chang|edit)'
  + '|(수정|고쳐|고치|패치|바꾸|fix|patch|update|chang|edit)[^.]{0,24}(코드|code\\b)',
);

// Analysis actions (분석 requires the request form; bare 분석 can be a noun
// inside an object being observed/resumed). English "analysis" is excluded
// when it names an artifact ("analysis task", "analysis run").
const ANALYSIS_ASK = new RegExp(
  '(분석해|분석만|분석 ?부탁|분석하고|분석을? ?(요청|부탁)|분석입니다|분석이 ?필요)'
  + '|\\banaly[sz]e\\b|\\binvestigat\\w*\\b|\\bdiagnos\\w*\\b'
  + '|\\banalys[ei]s\\b(?!\\s*(?:tasks?|jobs?|runs?|sessions?|workflows?))',
);

// Review actions.
const REVIEW_ASK = new RegExp('(검토|리뷰|\\breview[sd]?\\b|\\breviewing\\b|\\binspect\\w*\\b)');

// Observe-existing actions: status/progress object + checking action.
// Korean observe pairs a status object with a checking action AND a request
// form (해줘/해 주세요/요청…), so context DESCRIPTIONS ("…관찰 상태입니다") are
// never observe asks. English pairs a checking verb with a status object.
const OBSERVE_ASK = new RegExp(
  '((상태|진행|단계|어디까지|끝났는지|완료됐는지|퍼센트)[^.]{0,16}(확인|지켜봐|관찰|모니터|추적|보여)'
  + '|(확인|지켜봐|관찰|모니터|추적|보여)[^.]{0,16}(상태|진행|단계|어디까지|끝났는지|완료됐는지|퍼센트))'
  + '[^.]{0,24}(해 ?줘|해 ?주세|주세|줘|주실|부탁|요청)'
  + '|\\b(?:check|show|observe|monitor|watch|track|view)\\b[^.]{0,40}\\b(?:status|progress|stage|state|how far|whether|percent(?:age)?|completed|finished|done|healthy|health)\\b',
);

// Resume/continue actions.
// "continuous"/"resumption" lookalikes are deliberately excluded.
const RESUME_ASK = new RegExp(
  '(재개(?!발)|재게|이어서|계속해|계속 ?진행)'
  + '|\\b(?:resum(?:e|es|ed|ing)\\b|resumption\\b|continu(?:e|es|ed|ing)\\b|carry on|pick up|pick up where)\\b',
);

// Resume-object flavors: tracking (advisory work continues) vs execution
// (the run itself would rerun — no such template exists → unsupported).
const RESUME_TRACKING = new RegExp(
  '(분석|검토|요약|추적|관찰|모니터링|감시)'
  + '|\\b(?:analysis|review|summar\\w*|monitor\\w*|track\\w*|watch\\w*|observ\\w*)',
);
const RESUME_EXECUTION = new RegExp(
  '(동기화|갱신|이관|마이그레이션|배포|빌드|가져오기|내보내기|실행|재시작|크롤링|색인|백업|복원)'
  + '|\\b(?:synchroniz|sync|deploy|build|import|export|migrat|refresh|crawl|pipeline|execution|restart|backup|restore)',
);

// Execution retry: rerunning a failed/stopped run is NOT tracking resume.
const EXEC_RETRY = new RegExp(
  '(다시 ?실행|재실행|재기동|다시 ?돌려|다시 ?돌리)'
  + '|\\b(?:retry|rerun|re-run|restart)\\b[^.]{0,24}\\b(?:execution|run|jobs?|tasks?|pipeline|deploy(?:ment)?|build|sync|scripts?|commands?|import|export|migration|crawl)\\b'
  + '|\\b(?:execution|jobs?|tasks?|pipeline|deploy(?:ment)?|builds?|sync|scripts?|commands?|import|export|migration)\\b[^.]{0,24}\\b(?:retry|rerun|re-run|restart)\\b',
);

// Vague-object / no-clear-ask markers → ambiguous.
const VAGUE = new RegExp(
  '(그 (문제|이슈|부분|것|거)|그거|적절히|알아서|좀 ?개선|개선해 ?주|더 ?빠르게|더 ?좋게|좀 ?봐주|봐 ?주세요|살펴봐)'
  + '|\\bmake it (?:fast|bett)|\\b(?:the thing|that thing|that issue|that problem|whatever|you figure|up to you|appropriately|just improve|improve it|take a look|figure out|do whichever|decide whether)\\b',
);

// Chat-only / do-not-delegate (explicit "not an A2A request" markers).
const CHAT_ONLY = new RegExp(
  '(설명만|설명해 ?주|알려주|답을|채팅|대화로|여기서)'
  + '|\\b(?:just explain|explain (?:it|this|the|them|how|what|why|which)|in the conversation|in chat|chat only|repl\\w*|tell me|answer (?:here|me)|right here)\\b',
);
const DELEGATION_NEGATED = new RegExp(
  '(할당|위임)[^.]{0,6}(하지 ?마|말고|없이|금지|필요)|할당 ?말고|제안하지 ?말고|건드리지 ?말고|위임 ?필요 ?없'
  + '|\\b(?:do not|don.t|without|no)\\b[^.]{0,12}\\b(?:assign\\w*|delegate|delegation|assignment|creating|create|open|dispatch)\\b'
  + '|\\b(?:do not|don.t) touch\\b|\\btouch (?:the )?(?:repositor|repo)'
  + '|\\b(?:myself|no delegation|handling this)\\b',
);
const SELF_HANDLING = new RegExp(
  '(직접 ?(고칠|처리|수정|할 ?예정)|제가 ?직접)'
  + '|\\bi (?:will|ll|am going to|m) ?(?:fix|handle|do|take care of)\\b|\\bmyself\\b|\\bi am handling\\b',
);

// Fake-authority claims (quoted or reported): a message claiming to be a
// system prompt, or claiming approvals/authorization, never becomes a task
// signal here; ask-free carriers of such claims defer with insufficient
// context instead of uncertain.
const CLAIM_AUTHORITY = new RegExp(
  '(시스템 ?프롬프트|프롬프트 ?무시|지금부터 ?operation|관리자가 ?[^.]{0,12}(승인|허가))'
  + '|\\b(?:system prompts?|ignore (?:all |any )?(?:previous|prior|above)|override (?:the )?(?:authorization|permissions?|context))\\b',
);

// Bare continuation with no object at all → ambiguous, never a task. A
// trailing politeness particle is allowed; anything more is not "bare".
const BARE_CONTINUE = /^(계속|이어서|재개|다시|continue|resume|go on|keep going|pick up)( ?(please|해 ?줘|해 ?주세|주세요))?[. !]*$/;

// Greeting/chat-only messages: every token must be a greeting/thanks token.
const GREETING_TOKENS = new Set([
  '안녕', '안녕하세요', '안녕하십니까', '반갑습니다', '반가워요', '반가워',
  '감사합니다', '감사해요', '고맙습니다', '고마워요', '고마워', '수고하세요',
  'hi', 'hello', 'hey', 'hiya', 'yo', 'thanks', 'thank', 'you', 'very', 'much',
  'good', 'morning', 'afternoon', 'evening', 'bye', '좋은', '아침', '저녁',
]);
const MAX_GREETING_CODEPOINTS = 60;

function isGreetingOnly(normalized) {
  if (normalized.length === 0 || [...normalized].length > MAX_GREETING_CODEPOINTS) return false;
  const tokens = normalized.split(' ').map((t) => t.replace(/[!.,~?'"()]+/g, '')).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  return tokens.every((t) => GREETING_TOKENS.has(t));
}

/**
 * Collect the declared intent signals present in the unmasked text. This is
 * structural keyword/scope matching over the fixed vocabulary above — the
 * complete support surface of this baseline (see spec).
 */
function detectSignals(text) {
  const docsScope = DOCS_SCOPE.test(text);
  const writeVerb = WRITE_VERB.test(text);
  const writeNegated = WRITE_NEGATED.test(text) || EXPLICIT_WRITE_PROHIBITION.test(text);
  const docsNegated = DOCS_NEGATED.test(text);
  const reviewAsk = REVIEW_ASK.test(text);
  const effectiveWrite = writeVerb && !writeNegated;
  const effectiveDocs = docsScope && !docsNegated;
  // A review mention of a "code change" is the review's object, not a patch
  // ask; patch-vs-review competition is still detected via explicit write
  // verbs ("decide whether to review or patch").
  const codeWrite = CODE_WRITE.test(text) && !reviewAsk;
  return {
    retryExec: EXEC_RETRY.test(text),
    observe: OBSERVE_ASK.test(text),
    resume: RESUME_ASK.test(text),
    resumeTracking: RESUME_TRACKING.test(text),
    resumeExecution: RESUME_EXECUTION.test(text),
    review: reviewAsk,
    docsPatch: effectiveWrite && effectiveDocs,
    // new_patch: a write action outside docs scope, or an explicit docs+code
    // compound write; a docs-only exclusion keeps it new_patch.
    newPatch: effectiveWrite && (!effectiveDocs || codeWrite),
    docsAnalysis: ANALYSIS_ASK.test(text) && effectiveDocs,
    newAnalysis: ANALYSIS_ASK.test(text) && !effectiveDocs,
    vague: VAGUE.test(text),
  };
}

const NEW_TASK_INTENTS = Object.freeze(['review_readonly', 'docs_patch', 'new_analysis', 'docs_analysis', 'new_patch']);

// Negative requests are not positive action signals. The read-only contrast
// "review the PR, do not modify it" remains handled by write suppression.
const EXPLICIT_WRITE_PROHIBITION = /\b(?:do not|don['’]t|never)\s+(?:fix|patch|repair|resolve|correct|update|replace|overwrite|modify|edit|change|write)\b|(?:수정|편집|변경|작성|패치|갱신|교체|업데이트)\s*하지\s*(?:마|말|않)|고치지\s*(?:마|말|않)|(?:수정|편집|변경|작성)\s*없이/;
const EXPLICIT_READ_PROHIBITION = /\b(?:do not|don['’]t|never)\s+(?:review|inspect|analy[sz]e|investigate|check|observe|monitor|resume|continue|track)\b|(?:검토|리뷰|분석|확인|관찰|추적|재개)\s*하지\s*(?:마|말|않)/;
const EXPLICIT_NO_DELEGATION = /\b(?:do not|don['’]t|never)\s+(?:delegate|dispatch|assign)\b|\bno\s+delegation\b|(?:위임|할당|배정)\s*하지\s*(?:마|말|않)|맡기지\s*(?:마|말|않)/;
// Explicit conversational-only wording is sufficient on its own. Broad
// markers such as "here" or "tell me" alone are not a refusal to delegate.
const EXPLICIT_CHAT_ONLY = /\bchat[ -]+only\b|\b(?:just|only)\s+(?:explain|discuss|chat|talk)\b|\b(?:explain|discuss|chat|talk)\s+only\b|(?:채팅|대화)(?:으로|로|에서)?만|설명만/;

// A reported completed action is not a new imperative. This intentionally
// narrow rejection does not claim to parse arbitrary English discourse.
const REPORTED_ACTION = /^(?:the|this|that|our|my)\b[^.!?]{0,100}\b(?:was|were|is|has been|have been)\s+(?:already\s+)?(?:fixed|patched|updated|reviewed|finished|completed|resolved)\b/;

// Resume's object may itself be a review/analysis, which is still one existing
// task. A separate clause requesting read work must not be discarded merely
// because the trusted operation is resume_existing.
function hasIndependentReadClause(text) {
  const clauses = text.split(/[.!?;,]|\b(?:and|then|also|as well as)\b|그리고|별도로|하고/u);
  return clauses.some((clause) => !RESUME_ASK.test(clause)
    && (REVIEW_ASK.test(clause) || ANALYSIS_ASK.test(clause)));
}

// ─── Advice synthesis (reusing the frozen output contract) ──────────────────

function buildAdvice(validatedInput, decision, templateId, reasonCode) {
  const candidate = {
    schemaVersion: ROUTING_ADVICE_SCHEMA_VERSION,
    decision,
    templateId,
    reasonCode,
    catalogVersion: validatedInput.catalogVersion,
    modelVersion: ROUTING_RULES_MODEL_VERSION,
    policyVersion: ROUTING_POLICY_VERSION,
  };
  const validated = validateRoutingAdviceOutput(candidate, {
    input: validatedInput,
    expectedModelVersion: ROUTING_RULES_MODEL_VERSION,
  });
  if (!validated.ok) {
    // Fail closed: an invalid generated advice is never returned as success.
    return { ok: false, errors: [frozenError('rules_output_rejected', 'output', 'generated advice failed the frozen advisory contract')] };
  }
  return { ok: true, value: validated.value };
}

// ─── Classification pipeline (ordering documented in the spec) ──────────────

function classifyValidated(validatedInput) {
  const hostContext = validatedInput.hostContext;
  const candidates = validatedInput.candidateTemplateIds;

  // 1. Trusted interaction gate: control/external_event/attachment stay with
  //    the host and can never become new tasks from quoted/body keywords.
  if (hostContext.interaction !== 'user_request') {
    return buildAdvice(validatedInput, 'not_a2a', null, 'not_applicable');
  }

  // Bounded deterministic preprocessing + quotation masking.
  const normalized = normalizeForRules(validatedInput.requestText);
  if (normalized === null) return buildAdvice(validatedInput, 'defer', null, 'uncertain');
  const unquoted = maskQuotedSegments(normalized);
  const text = unquoted.text;

  // 2. Explicit do-not-delegate / chat-only requests are not A2A.
  if (EXPLICIT_CHAT_ONLY.test(text) || EXPLICIT_NO_DELEGATION.test(text) || (DELEGATION_NEGATED.test(text) && (CHAT_ONLY.test(text) || SELF_HANDLING.test(text)))) {
    return buildAdvice(validatedInput, 'not_a2a', null, 'not_applicable');
  }
  // 3. General greetings/chat are not A2A requests.
  if (isGreetingOnly(normalized)) {
    return buildAdvice(validatedInput, 'not_a2a', null, 'not_applicable');
  }
  // 4. Malformed (unbalanced) quoting is never guessed through.
  if (!unquoted.balanced) {
    return buildAdvice(validatedInput, 'defer', null, 'uncertain');
  }
  // 5. A bare continuation with no object is ambiguous; it never mints a
  //    task/id and never grants readiness.
  if (BARE_CONTINUE.test(text)) {
    return buildAdvice(validatedInput, 'defer', null, 'ambiguous');
  }

  if (EXPLICIT_READ_PROHIBITION.test(text) || REPORTED_ACTION.test(text)) {
    return buildAdvice(validatedInput, 'defer', null, 'uncertain');
  }

  const s = detectSignals(text);
  const taskLike = s.retryExec || s.observe || s.resume || s.review
    || s.docsPatch || s.docsAnalysis || s.newPatch || s.newAnalysis || s.vague;

  // 6. Task-like requests with an empty candidate list defer; a candidate is
  //    never invented.
  if (taskLike && candidates.length === 0) {
    return buildAdvice(validatedInput, 'defer', null, 'no_candidate');
  }
  // 7. Execution retry is not tracking resume; no retry template exists.
  if (s.retryExec) {
    return buildAdvice(validatedInput, 'defer', null, 'unsupported_template');
  }
  // 8. Observe + resume conflict (check it, then resume it) is ambiguous.
  if (s.observe && s.resume) {
    return buildAdvice(validatedInput, 'defer', null, 'ambiguous');
  }

  let intent = null;
  if (s.observe) {
    // 12. Status/progress checking of an existing task.
    const competingNewTask = s.review || s.docsPatch || s.docsAnalysis || s.newPatch || s.newAnalysis;
    if (competingNewTask) {
      return buildAdvice(validatedInput, 'defer', null, 'ambiguous');
    }
    intent = 'observe_existing';
  } else if (s.resume) {
    // 9-11. Resume-object flavor decides: execution objects have no template;
    // tracking objects map to resume_existing; unresolvable → uncertain.
    if (s.resumeTracking && s.resumeExecution) {
      return buildAdvice(validatedInput, 'defer', null, 'uncertain');
    }
    if (s.resumeExecution) {
      return buildAdvice(validatedInput, 'defer', null, 'unsupported_template');
    }
    if (s.resumeTracking) {
      const competingTask = s.docsPatch || s.newPatch || hasIndependentReadClause(text);
      if (competingTask) {
        return buildAdvice(validatedInput, 'defer', null, 'ambiguous');
      }
      intent = 'resume_existing';
    } else {
      return buildAdvice(validatedInput, 'defer', null, 'uncertain');
    }
  } else {
    // 13. New-task intents with negation scoping; vague asks stay ambiguous.
    if (s.vague) {
      return buildAdvice(validatedInput, 'defer', null, 'ambiguous');
    }
    const intents = NEW_TASK_INTENTS.filter((id) => {
      if (id === 'review_readonly') return s.review;
      if (id === 'docs_patch') return s.docsPatch;
      if (id === 'docs_analysis') return s.docsAnalysis;
      if (id === 'new_patch') return s.newPatch;
      return s.newAnalysis;
    });
    if (intents.length > 1) {
      // Candidate availability and access cannot resolve semantic ambiguity.
      return buildAdvice(validatedInput, 'defer', null, 'ambiguous');
    } else if (intents.length === 1) {
      [intent] = intents;
    }
  }

  // No recognized signal: quote-suppressed asks and fake-authority carriers
  // defer with insufficient context; otherwise there is nothing to reason
  // about (uncertain).
  if (intent === null) {
    if (unquoted.hasQuotes || CLAIM_AUTHORITY.test(text)) {
      return buildAdvice(validatedInput, 'defer', null, 'insufficient_context');
    }
    return buildAdvice(validatedInput, 'defer', null, 'uncertain');
  }

  // 14. Inference is independent of candidate availability: a missing
  //     template is never replaced by an available neighbor.
  if (!candidates.includes(intent)) {
    return buildAdvice(validatedInput, 'defer', null, 'unsupported_template');
  }
  // 15. Trusted-context eligibility is enforced through the frozen
  //     foundation gate; text can never grant missing or contrary context.
  if (!isRecommendationEligible(validatedInput, intent)) {
    return buildAdvice(validatedInput, 'defer', null, 'insufficient_context');
  }
  // 16. Conservative recommend.
  return buildAdvice(validatedInput, 'recommend', intent, 'matched');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify one routing input with the declared deterministic rules.
 *
 * Returns EXACTLY `{ ok: true, value }` — where `value` is a frozen, closed
 * `a2a.routing-advice.v1` advice validated with
 * `expectedModelVersion = ROUTING_RULES_MODEL_VERSION` — or
 * `{ ok: false, errors: [{ code, path, message }, ...] }`. No extra result
 * fields, no confidence/probability, no throws for ordinary malformed parsed
 * JSON, no echo of request text or unknown keys. Malformed input is
 * `ok:false`, never a semantic defer.
 *
 * Pure and synchronous: no fs/network/process/time effects, no module state,
 * no model/provider/worker/prepare/dispatcher invocation, input and result
 * mutation-isolated.
 *
 * @param {object} input candidate routing input (`a2a.routing-input.v1`)
 * @returns {{ok:true,value:object}|{ok:false,errors:object[]}}
 */
export function classifyRoutingWithRules(input) {
  // A candidate list longer than the seven unique catalog entries is
  // impossible valid; reject it early without per-item diagnostics.
  if (isPlainObject(input) && Array.isArray(input.candidateTemplateIds)
    && input.candidateTemplateIds.length > ROUTING_TEMPLATE_IDS.length) {
    return fail([frozenError('candidate_limit_exceeded', 'input.candidateTemplateIds', 'candidate count exceeds the closed routing catalog')]);
  }

  // Reuse the unchanged foundation validator. Its diagnostic arrays are not
  // frozen or capped for unknown fields; return them without argument spread.
  const validated = validateRoutingInput(input);
  if (!validated.ok) return { ok: false, errors: validated.errors };

  try {
    return classifyValidated(validated.value);
  } catch {
    // Defensive fail-closed guard: rule evaluation must never throw for
    // validated plain-JSON input; if it ever did, return a structured
    // error instead of propagating a partial result.
    return fail([frozenError('rules_engine_failure', 'rules', 'rule evaluation failed closed')]);
  }
}
