import type { RunnerResult } from "./types.js";

export interface EmbeddedModelTimeoutNoFallbackEvidence {
  category: "embedded_model_timeout_no_fallback";
  model?: string;
  provider?: string;
  durationMs?: number;
}

export function detectEmbeddedModelTimeoutNoFallback(result: RunnerResult): EmbeddedModelTimeoutNoFallbackEvidence | undefined {
  const text = collectFailureText(result);
  const hasEmbeddedOpenClaw = /\[(?:agent\/embedded|model-fallback\/decision)\]|embedded run|openclaw_cli=OpenClaw/.test(text);
  const hasModelTimeout = /(?:LLM request timed out|FailoverError:\s*LLM request timed out|reason=timeout|rawError=terminated)/i.test(text);
  const hasNoFallback = /(?:\bnext=none\b|decision=surface_error[^\n]*reason=timeout|reason=timeout[^\n]*decision=surface_error)/i.test(text);
  if (!hasEmbeddedOpenClaw || !hasModelTimeout || !hasNoFallback) return undefined;

  return {
    category: "embedded_model_timeout_no_fallback",
    ...extractModelAndProvider(text),
    ...extractDuration(text),
  };
}

export function buildEmbeddedModelTimeoutSummary(result: RunnerResult, lang = "en"): string | undefined {
  const evidence = detectEmbeddedModelTimeoutNoFallback(result);
  if (!evidence) return undefined;

  const parts = [
    evidence.model ? `model=${evidence.model}` : undefined,
    evidence.provider ? `provider=${evidence.provider}` : undefined,
    evidence.durationMs ? `durationMs=${evidence.durationMs}` : undefined,
    "fallback=none",
  ].filter(Boolean).join(", ");

  if (lang === "ko") {
    return `Embedded OpenClaw 모델 호출이 timeout 되었고 fallback 후보가 없어 중단됐습니다 (${parts}). 이는 repo 코드 실패가 아니라 worker/runtime 실행 인프라 실패로 분류됩니다.`;
  }
  return `Embedded OpenClaw model call timed out with no fallback candidate (${parts}). This is classified as worker/runtime infrastructure failure, not repo-code failure.`;
}

function collectFailureText(result: RunnerResult): string {
  return [
    result.stdout,
    result.stderr,
    result.error,
    result.resultSummary?.stdout,
    result.resultSummary?.stderr,
    result.artifactManifest?.summary,
  ].filter(Boolean).join("\n");
}

function extractModelAndProvider(text: string): Pick<EmbeddedModelTimeoutNoFallbackEvidence, "model" | "provider"> {
  const requested = text.match(/\brequested=([^\s]+)/)?.[1];
  const from = text.match(/\bfrom=([^\s]+)/)?.[1];
  const modelProvider = text.match(/\bmodel=([^\s]+)\s+provider=([^\s]+)/);
  const model = requested ?? from ?? modelProvider?.[1];
  const provider = modelProvider?.[2] ?? model?.split("/")[0];
  return {
    ...(safeToken(model) ? { model } : {}),
    ...(safeToken(provider) ? { provider } : {}),
  };
}

function extractDuration(text: string): Pick<EmbeddedModelTimeoutNoFallbackEvidence, "durationMs"> {
  const values = [...text.matchAll(/\bdurationMs=(\d+)\b/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!values.length) return {};
  return { durationMs: Math.max(...values) };
}

function safeToken(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value));
}
