import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "../core/broker.js";
import { createBrokerAgentCard } from "./agent-card.js";
import { matchDefaultAgentConvention } from "./default-agent-conventions.js";
import { startDefaultAgent } from "./default-agent.js";
import { executeA2AJsonRpc, type ExecuteJsonRpcOptions, type JsonRpcFailure, type JsonRpcSuccess } from "./json-rpc.js";

const agentCard = createBrokerAgentCard({
  serviceName: "test-broker",
  publicBaseUrl: "https://broker.test/",
});

/**
 * Default-agent conformance-mode options: anonymous A2A client, spec wire
 * shape (as negotiated by the official TCK's A2A-Version header).
 */
function createConformanceOptions(broker: InMemoryA2ABroker): ExecuteJsonRpcOptions {
  return {
    broker,
    agentCard,
    publicBaseUrl: "https://broker.test",
    requesterIdentity: null,
    enforceRequesterIdentity: false,
    defaultAgentNodeId: "default-agent",
    responseShape: "spec",
  };
}

function sendMessage(
  broker: InMemoryA2ABroker,
  message: Record<string, unknown>,
  id: string | number = 1,
): JsonRpcSuccess | JsonRpcFailure {
  return executeA2AJsonRpc(
    { jsonrpc: "2.0", id, method: "SendMessage", params: { message } },
    createConformanceOptions(broker),
  );
}

function successResult(response: JsonRpcSuccess | JsonRpcFailure): Record<string, unknown> {
  assert.ok("result" in response, `expected success, got ${JSON.stringify(response)}`);
  return response.result as Record<string, unknown>;
}

test("convention matcher: prefix precedence, session suffix, and misses", () => {
  assert.equal(
    (matchDefaultAgentConvention("tck-artifact-file-url-s1") as { kind: string }).kind,
    "complete-with-artifacts",
  );
  const fileUrl = matchDefaultAgentConvention("tck-artifact-file-url-s1");
  assert.ok(fileUrl?.kind === "complete-with-artifacts");
  assert.equal(fileUrl.artifacts[0].parts[0].url, "https://example.com/output.txt");

  const file = matchDefaultAgentConvention("tck-artifact-file-s1");
  assert.ok(file?.kind === "complete-with-artifacts");
  assert.equal(file.artifacts[0].parts[0].filename, "output.txt");

  assert.equal((matchDefaultAgentConvention("tck-message-response-s1") as { kind: string }).kind, "direct-message");
  assert.equal(matchDefaultAgentConvention("hello-world"), null);
  assert.equal(matchDefaultAgentConvention(undefined), null);
});

test("tck-artifact-text: SendMessage returns terminal task with text artifact", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const result = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "TCK artifact test" }],
    messageId: "tck-artifact-text-session1",
  }));
  const task = result.task as { status: { state: string }; artifacts: Array<{ artifactId: string; parts: Array<Record<string, unknown>> }> };
  assert.equal(task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(task.artifacts.length, 1);
  assert.ok(task.artifacts[0].artifactId);
  assert.equal(task.artifacts[0].parts[0].text, "Generated text content");
});

test("tck-artifact-file / file-url / data: artifact part shapes", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);

  const file = successResult(sendMessage(broker, { role: "ROLE_USER", parts: [{ text: "x" }], messageId: "tck-artifact-file-s" }, 2));
  const filePart = (file.task as { artifacts: Array<{ parts: Array<Record<string, unknown>> }> }).artifacts[0].parts[0];
  assert.equal(filePart.raw, "dGNr");
  assert.equal(filePart.mediaType, "text/plain");
  assert.equal(filePart.filename, "output.txt");

  const fileUrl = successResult(sendMessage(broker, { role: "ROLE_USER", parts: [{ text: "x" }], messageId: "tck-artifact-file-url-s" }, 3));
  const urlPart = (fileUrl.task as { artifacts: Array<{ parts: Array<Record<string, unknown>> }> }).artifacts[0].parts[0];
  assert.equal(urlPart.url, "https://example.com/output.txt");
  assert.equal(urlPart.mediaType, "text/plain");
  assert.equal(urlPart.filename, "output.txt");

  const data = successResult(sendMessage(broker, { role: "ROLE_USER", parts: [{ text: "x" }], messageId: "tck-artifact-data-s" }, 4));
  const dataPart = (data.task as { artifacts: Array<{ parts: Array<Record<string, unknown>> }> }).artifacts[0].parts[0];
  assert.deepEqual(dataPart.data, { key: "value", count: 42 });
});

test("tck-message-response: SendMessage returns a direct Message, not a task", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const result = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "TCK artifact test" }],
    messageId: "tck-message-response-session1",
  }));
  assert.equal(result.task, undefined);
  const message = result.message as { messageId: string; role: string; parts: Array<{ text: string }> };
  assert.ok(message.messageId);
  assert.equal(message.role, "ROLE_AGENT");
  assert.equal(message.parts[0].text, "Direct message response");
});

test("message.taskId referencing a missing task is TaskNotFoundError (-32001)", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const response = sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "Message to invalid task" }],
    messageId: "tck-multi-004-s",
    taskId: "tck-nonexistent-multi-004-s",
  });
  assert.ok("error" in response, "unknown taskId must fail");
  assert.equal(response.error.code, -32001);
  const info = Array.isArray(response.error.data) ? response.error.data[0] : undefined;
  assert.equal(info?.reason, "TASK_NOT_FOUND");
});

test("message.taskId binds the message to the referenced task context", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const first = successResult(sendMessage(broker, { role: "ROLE_USER", parts: [{ text: "first" }], messageId: "m-1" }));
  const task = first.task as { id: string; contextId: string };

  const second = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "follow-up" }],
    messageId: "m-2",
    taskId: task.id,
  }, 2));
  // Spec SendMessageResponse is a oneof { task | message }; the context id
  // rides inside the returned task.
  assert.equal((second.task as { contextId: string }).contextId, task.contextId);
});

test("message.taskId with a mismatching contextId is rejected", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const first = successResult(sendMessage(broker, { role: "ROLE_USER", parts: [{ text: "first" }], messageId: "m-1" }));
  const task = first.task as { id: string };

  const response = sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "confused" }],
    messageId: "m-2",
    taskId: task.id,
    contextId: "some-other-context",
  }, 2);
  assert.ok("error" in response, "mismatching contextId must fail");
  assert.equal(response.error.code, -32602);
});

test("file part with unsupported media type is ContentTypeNotSupportedError (-32005)", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const response = sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ raw: "dGNr", mediaType: "application/x-unsupported-tck-type" }],
    messageId: "tck-send-003-s",
  });
  assert.ok("error" in response, "unsupported media type must fail");
  assert.equal(response.error.code, -32005);
  const info = Array.isArray(response.error.data) ? response.error.data[0] : undefined;
  assert.equal(info?.domain, "a2a-protocol.org");
  assert.equal(info?.reason, "CONTENT_TYPE_NOT_SUPPORTED");
});

test("text/plain file part stays accepted in default-agent mode", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const response = sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "with attachment" }, { raw: "aGVsbG8=", mediaType: "text/plain", filename: "note.txt" }],
    messageId: "m-text-file",
  });
  assert.ok("result" in response, `text/plain file part must stay accepted, got ${JSON.stringify(response)}`);
});

test("tck-complete-task: SendMessage response shows a completed task", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const result = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "TCK prerequisite task creation" }],
    messageId: "tck-complete-task-session1",
  }));
  const task = result.task as { status: { state: string; message?: { parts: Array<{ text: string }> } } };
  assert.equal(task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(task.status.message?.parts[0].text, "Hello from TCK");
});

test("message.taskId referencing a terminal task is UnsupportedOperationError (-32004)", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const first = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "TCK prerequisite task creation" }],
    messageId: "tck-complete-task-session1",
  }));
  const taskId = (first.task as { id: string }).id;

  const response = sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "Follow-up to terminal task" }],
    messageId: "tck-terminal-followup",
    taskId,
  }, 2);
  assert.ok("error" in response, "message to a terminal task must fail");
  assert.equal(response.error.code, -32004);
  const info = Array.isArray(response.error.data) ? response.error.data[0] : undefined;
  assert.equal(info?.reason, "UNSUPPORTED_OPERATION");
});

test("SubscribeToTask on a terminal task is UnsupportedOperationError (-32004)", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const first = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "TCK prerequisite task creation" }],
    messageId: "tck-complete-task-session1",
  }));
  const taskId = (first.task as { id: string }).id;

  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 3, method: "SubscribeToTask", params: { id: taskId } },
    createConformanceOptions(broker),
  );
  assert.ok("error" in response, "subscribe to a terminal task must fail");
  assert.equal(response.error.code, -32004);
  const info = Array.isArray(response.error.data) ? response.error.data[0] : undefined;
  assert.equal(info?.reason, "UNSUPPORTED_OPERATION");
});

test("SubscribeToTask on a non-terminal task still returns the snapshot", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const first = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "ordinary echo" }],
    messageId: "m-plain",
  }));
  const taskId = (first.task as { id: string }).id;

  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 4, method: "SubscribeToTask", params: { id: taskId } },
    createConformanceOptions(broker),
  );
  // The embedded agent may finish the echo task asynchronously; only the
  // synchronous creation window is asserted — if the task already reached
  // terminal the -32004 contract above applies instead.
  if ("error" in response) {
    assert.equal(response.error.code, -32004);
  } else {
    const result = response.result as { task?: { id?: string }; subscription?: { url?: string } };
    assert.equal(result.task?.id, taskId);
    assert.ok(result.subscription?.url);
  }
});

test("tck-input-required: response shows input-required, follow-up resumes to completion", async () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const result = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "TCK prerequisite task creation" }],
    messageId: "tck-input-required-session1",
  }));
  const task = result.task as { id: string; contextId: string; status: { state: string } };
  assert.equal(task.status.state, "TASK_STATE_INPUT_REQUIRED");

  // The embedded agent must not complete a checkpointed task behind the
  // client's back — give the async drive loop a chance to misbehave.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(broker.getTask(task.id)?.status, "running");
  assert.equal(broker.getTask(task.id)?.checkpoint?.state, "awaiting_operator");

  // A follow-up context message IS the requested input: checkpoint clears
  // and the agent drives the task to terminal.
  const followup = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "requested input" }],
    messageId: "m-resume",
    contextId: task.contextId,
  }, 2));
  assert.ok(followup.task, "resume path returns the task");
  for (let i = 0; i < 50; i++) {
    const current = broker.getTask(task.id);
    if (current?.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(broker.getTask(task.id)?.status, "succeeded");
});

test("anonymous CancelTask works in default-agent mode (input-required task)", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const first = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "TCK prerequisite task creation" }],
    messageId: "tck-input-required-cancel",
  }));
  const taskId = (first.task as { id: string }).id;

  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 5, method: "CancelTask", params: { id: taskId } },
    createConformanceOptions(broker),
  );
  const result = successResult(response);
  // Spec shape returns the bare Task object.
  assert.equal((result as { status: { state: string } }).status.state, "TASK_STATE_CANCELED");
});

test("CancelTask on a terminal task is TaskNotCancelableError (-32002)", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const first = successResult(sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "TCK prerequisite task creation" }],
    messageId: "tck-complete-task-cancel",
  }));
  const taskId = (first.task as { id: string }).id;

  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 6, method: "CancelTask", params: { id: taskId } },
    createConformanceOptions(broker),
  );
  assert.ok("error" in response, "cancel of a terminal task must fail");
  assert.equal(response.error.code, -32002);
  const info = Array.isArray(response.error.data) ? response.error.data[0] : undefined;
  assert.equal(info?.reason, "TASK_NOT_CANCELABLE");
});

test("unknown client-provided contextId is Invalid params (-32602), not a resource miss", () => {
  const broker = new InMemoryA2ABroker();
  startDefaultAgent(broker);
  const response = sendMessage(broker, {
    role: "ROLE_USER",
    parts: [{ text: "Message with client contextId" }],
    messageId: "tck-multi-002a-s",
    contextId: "tck-client-context-rejected-s",
  });
  assert.ok("error" in response, "unknown contextId must be rejected");
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /unknown contextId/);
});

test("conventions do not fire without default-agent mode (router unchanged)", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
  const options: ExecuteJsonRpcOptions = {
    broker,
    agentCard,
    publicBaseUrl: "https://broker.test",
    requesterIdentity: { id: "caller-node", kind: "node", role: "hub" },
    enforceRequesterIdentity: true,
    responseShape: "spec",
  };
  const response = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: {
        message: { role: "ROLE_USER", parts: [{ text: "x" }], messageId: "tck-artifact-text-s" },
        metadata: { targetNodeId: "worker-a", intent: "analyze" },
      },
    },
    options,
  );
  const result = successResult(response);
  const task = result.task as { status: { state: string }; artifacts: unknown[] };
  // Router mode: no inline drive, no convention artifacts.
  assert.equal(task.status.state, "TASK_STATE_SUBMITTED");
  assert.deepEqual(task.artifacts, []);
});
