import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkerModelInputs, canonicalizeWorkerModel } from "./worker-model-policy.mjs";

test("Luna worker env and explicit task models never silently fall back to Sol", () => {
  for (const model of ["gpt-5.6-luna", "openai-codex/gpt-5.6-luna"]) {
    assert.equal(resolveWorkerModelInputs({ envModel: model }).model, model);
    assert.equal(resolveWorkerModelInputs({ payloadModel: model }).model, model);
    assert.equal(canonicalizeWorkerModel(model), "openai-codex/gpt-5.6-luna");
  }
  assert.ok(resolveWorkerModelInputs({ payloadModel: "gpt-unknown" }).error);
});
