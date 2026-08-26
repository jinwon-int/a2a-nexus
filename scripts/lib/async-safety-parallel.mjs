/**
 * Worker-thread fan-out for the per-package floating-Promise analysis.
 *
 * analyzeProject creates a full ts.Program (a complete typecheck) per package,
 * so running the five per-package analyses sequentially dominates the
 * source-quality gate's wall clock. This module runs them across
 * worker_threads bounded by the CPU budget while keeping findings
 * deterministic: results are collected per package and returned in the
 * caller's package order (the caller re-applies its own final sort).
 *
 * The file doubles as its own worker entry point so the pool needs no
 * separate worker script. Any per-package analysis error fails closed, and
 * the error surfaced is the one for the lowest package index so failure
 * output does not depend on scheduling.
 */
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const WORKER_KIND = 'a2a-async-safety-analysis';

if (!isMainThread && workerData?.kind === WORKER_KIND) {
  const { analyzeProject } = await import('./async-safety.mjs');
  try {
    parentPort.postMessage({ ok: true, findings: analyzeProject(workerData.project) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function runAnalysisWorker(project) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: WORKER_KIND, project },
    });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    worker.once('message', (message) => {
      if (message.ok) settle(resolve, message.findings);
      else settle(reject, new Error(message.error));
    });
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) => {
      settle(reject, new Error(`async-safety analysis worker exited with code ${code} before reporting`));
    });
  });
}

/**
 * Analyze projects ({ configPath, packageRoot } entries) across worker
 * threads. Resolves to one findings array per project, in project order;
 * rejects (fail closed) with the first-by-index per-project error.
 */
export async function analyzeProjectsParallel(projects, { concurrency } = {}) {
  const budget = Math.max(
    1,
    Math.min(concurrency ?? Math.min(os.cpus().length, 8), projects.length || 1),
  );
  const results = new Array(projects.length);
  const errors = new Array(projects.length);
  let cursor = 0;
  async function pump() {
    while (cursor < projects.length) {
      const index = cursor++;
      try {
        results[index] = await runAnalysisWorker(projects[index]);
      } catch (error) {
        errors[index] = error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  await Promise.all(Array.from({ length: budget }, pump));
  const firstError = errors.find((error) => error !== undefined);
  if (firstError) throw firstError;
  return results;
}
