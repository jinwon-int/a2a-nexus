/**
 * Plugin-local TypeBox schemas for A2A gateway methods.
 * Source: original src/gateway/protocol/schema/a2a.ts, adapted for plugin boundary.
 */
import { Static, Type } from "@sinclair/typebox";

const NonEmptyString = Type.String({ minLength: 1 });

// ── a2a.task.request ──────────────────────────────────────────
export const A2ATaskRequestParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    request: Type.Object(
      {
        method: Type.Literal("a2a.task.request"),
        taskId: Type.Optional(NonEmptyString),
        correlationId: Type.Optional(NonEmptyString),
        parentRunId: Type.Optional(NonEmptyString),
        requester: Type.Optional(
          Type.Object(
            {
              sessionKey: NonEmptyString,
              displayKey: NonEmptyString,
              channel: Type.Optional(NonEmptyString),
            },
            { additionalProperties: false },
          ),
        ),
        target: Type.Object(
          {
            sessionKey: NonEmptyString,
            displayKey: NonEmptyString,
            channel: Type.Optional(NonEmptyString),
          },
          { additionalProperties: false },
        ),
        task: Type.Object(
          {
            intent: Type.Union([
              Type.Literal("delegate"),
              Type.Literal("ask"),
              Type.Literal("handoff"),
              Type.Literal("notify"),
            ]),
            summary: Type.Optional(NonEmptyString),
            instructions: NonEmptyString,
            input: Type.Optional(Type.Record(NonEmptyString, Type.Unknown())),
            expectedOutput: Type.Optional(
              Type.Object(
                {
                  format: Type.Union([Type.Literal("text"), Type.Literal("json")]),
                  schemaName: Type.Optional(NonEmptyString),
                },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        constraints: Type.Optional(
          Type.Object(
            {
              timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
              maxPingPongTurns: Type.Optional(Type.Integer({ minimum: 0 })),
              requireFinal: Type.Optional(Type.Boolean()),
              allowAnnounce: Type.Optional(Type.Boolean()),
              priority: Type.Optional(
                Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")]),
              ),
            },
            { additionalProperties: false },
          ),
        ),
        runtime: Type.Optional(
          Type.Object(
            {
              announceTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
              maxPingPongTurns: Type.Optional(Type.Integer({ minimum: 0 })),
              roundOneReply: Type.Optional(Type.String()),
              waitRunId: Type.Optional(NonEmptyString),
              cancelTarget: Type.Optional(
                Type.Object(
                  {
                    kind: Type.Literal("session_run"),
                    sessionKey: NonEmptyString,
                    runId: Type.Optional(NonEmptyString),
                  },
                  { additionalProperties: false },
                ),
              ),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type A2ATaskRequestParams = Static<typeof A2ATaskRequestParamsSchema>;

// ── a2a.task.update ──────────────────────────────────────────
export const A2ATaskUpdateParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    update: Type.Object(
      {
        method: Type.Literal("a2a.task.update"),
        taskId: NonEmptyString,
        correlationId: Type.Optional(NonEmptyString),
        parentRunId: Type.Optional(NonEmptyString),
        executionStatus: Type.Optional(
          Type.Union([
            Type.Literal("accepted"),
            Type.Literal("running"),
            Type.Literal("waiting_reply"),
            Type.Literal("waiting_external"),
            Type.Literal("completed"),
            Type.Literal("failed"),
            Type.Literal("timed_out"),
          ]),
        ),
        summary: Type.Optional(Type.String()),
        output: Type.Optional(Type.Unknown()),
        heartbeat: Type.Optional(Type.Boolean()),
        at: Type.Optional(Type.Number()),
        error: Type.Optional(
          Type.Object(
            {
              code: NonEmptyString,
              message: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
        deliveryStatus: Type.Optional(
          Type.Union([
            Type.Literal("pending"),
            Type.Literal("sent"),
            Type.Literal("accepted"),
            Type.Literal("provider_delivered_if_known"),
            Type.Literal("operator_visible"),
            Type.Literal("skipped"),
            Type.Literal("timed_out"),
            Type.Literal("stale"),
            Type.Literal("failed"),
          ]),
        ),
        deliveryErrorMessage: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type A2ATaskUpdateParams = Static<typeof A2ATaskUpdateParamsSchema>;

// ── a2a.task.cancel ──────────────────────────────────────────
export const A2ATaskCancelParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    cancel: Type.Object(
      {
        method: Type.Literal("a2a.task.cancel"),
        taskId: NonEmptyString,
        correlationId: Type.Optional(NonEmptyString),
        parentRunId: Type.Optional(NonEmptyString),
        at: Type.Optional(Type.Number()),
        reason: Type.Optional(Type.String()),
        runId: Type.Optional(NonEmptyString),
        targetSessionKey: Type.Optional(NonEmptyString),
        cancelTarget: Type.Optional(
          Type.Object(
            {
              kind: Type.Literal("session_run"),
              sessionKey: NonEmptyString,
              runId: Type.Optional(NonEmptyString),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type A2ATaskCancelParams = Static<typeof A2ATaskCancelParamsSchema>;

// ── a2a.task.approve ─────────────────────────────────────────
export const A2ATaskApproveParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    approval: Type.Object(
      {
        method: Type.Literal("a2a.task.approve"),
        taskId: NonEmptyString,
        correlationId: Type.Optional(NonEmptyString),
        parentRunId: Type.Optional(NonEmptyString),
        approvalId: Type.Optional(NonEmptyString),
        reason: Type.Optional(Type.String()),
        at: Type.Optional(Type.Number()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type A2ATaskApproveParams = Static<typeof A2ATaskApproveParamsSchema>;

// ── a2a.task.reject_approval ─────────────────────────────────
export const A2ATaskRejectApprovalParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    approval: Type.Object(
      {
        method: Type.Literal("a2a.task.reject_approval"),
        taskId: NonEmptyString,
        correlationId: Type.Optional(NonEmptyString),
        parentRunId: Type.Optional(NonEmptyString),
        approvalId: Type.Optional(NonEmptyString),
        status: Type.Optional(
          Type.Union([
            Type.Literal("rejected"),
            Type.Literal("expired"),
            Type.Literal("canceled"),
          ]),
        ),
        reason: Type.Optional(Type.String()),
        at: Type.Optional(Type.Number()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type A2ATaskRejectApprovalParams = Static<typeof A2ATaskRejectApprovalParamsSchema>;

// ── a2a.task.status ──────────────────────────────────────────
export const A2ATaskStatusParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    taskId: NonEmptyString,
  },
  { additionalProperties: false },
);

export type A2ATaskStatusParams = Static<typeof A2ATaskStatusParamsSchema>;

// ── a2a.alerts.list ──────────────────────────────────────────
export const A2AAlertsListParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export type A2AAlertsListParams = Static<typeof A2AAlertsListParamsSchema>;

// ── a2a.peer.status ──────────────────────────────────────────
export const A2APeerStatusParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    target: NonEmptyString,
    maxCacheAgeMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export type A2APeerStatusParams = Static<typeof A2APeerStatusParamsSchema>;

// ── a2a.monitor.status ───────────────────────────────────────
export const A2AMonitorStatusParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    taskId: Type.Optional(NonEmptyString),
    operatorEvents: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          cursor: Type.Optional(NonEmptyString),
          terminalOutboxCursor: Type.Optional(NonEmptyString),
          terminalOutboxLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
          preflight: Type.Optional(Type.Boolean()),
          notification: Type.Optional(
            Type.Object(
              {
                enabled: Type.Optional(Type.Boolean()),
                channel: Type.Optional(NonEmptyString),
                to: Type.Optional(NonEmptyString),
                chatId: Type.Optional(NonEmptyString),
                accountId: Type.Optional(NonEmptyString),
                threadId: Type.Optional(
                  Type.Union([NonEmptyString, Type.Number()]),
                ),
                allowUnconfirmedProviderSend: Type.Optional(Type.Boolean()),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type A2AMonitorStatusParams = Static<typeof A2AMonitorStatusParamsSchema>;
