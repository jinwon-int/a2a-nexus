/**
 * Single-agent conformance conventions for the embedded default agent
 * (a2a-nexus#1500, artifact/message projection category).
 *
 * The official A2A TCK (a2aproject/a2a-tck) drives SUT behavior through
 * messageId prefixes — its reference agent (sut/a2a-python/sut_agent.py)
 * answers `tck-artifact-text-*` with a text artifact, `tck-message-response-*`
 * with a direct Message, and so on. A SUT running the embedded default agent
 * is the agent under test, so the same conventions are implemented here.
 *
 * These conventions ONLY apply when the broker runs in default-agent mode
 * (the single-agent conformance profile). Production multi-worker routing
 * never interprets messageId prefixes.
 *
 * The artifact payloads mirror the TCK's expectations exactly; keep them in
 * sync with the pinned TCK ref in .github/workflows/tck-measurement.yml.
 */

/** A2A 1.0 proto-JSON Part (oneof text | raw | url | data). */
export type A2ASpecPart = Record<string, unknown>;

/** A2A 1.0 proto-JSON Artifact: artifactId + parts are REQUIRED. */
export interface A2ASpecArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2ASpecPart[];
}

export type DefaultAgentConvention =
  | { kind: "complete-with-artifacts"; summary: string; artifacts: A2ASpecArtifact[] }
  | { kind: "complete-with-message"; summary: string }
  | { kind: "direct-message"; text: string };

/** base64("tck") — the raw bytes payload the TCK's file-artifact test expects. */
const TCK_FILE_RAW_BASE64 = "dGNr";

const CONVENTIONS: Array<{ prefix: string; plan: DefaultAgentConvention }> = [
  {
    prefix: "tck-artifact-text",
    plan: {
      kind: "complete-with-artifacts",
      summary: "generated text artifact",
      artifacts: [
        {
          artifactId: "tck-artifact-text",
          name: "text-artifact",
          parts: [{ text: "Generated text content" }],
        },
      ],
    },
  },
  {
    prefix: "tck-artifact-file-url",
    plan: {
      kind: "complete-with-artifacts",
      summary: "generated file-url artifact",
      artifacts: [
        {
          artifactId: "tck-artifact-file-url",
          name: "file-url-artifact",
          parts: [
            {
              url: "https://example.com/output.txt",
              mediaType: "text/plain",
              filename: "output.txt",
            },
          ],
        },
      ],
    },
  },
  {
    prefix: "tck-artifact-file",
    plan: {
      kind: "complete-with-artifacts",
      summary: "generated file artifact",
      artifacts: [
        {
          artifactId: "tck-artifact-file",
          name: "file-artifact",
          parts: [{ raw: TCK_FILE_RAW_BASE64, mediaType: "text/plain", filename: "output.txt" }],
        },
      ],
    },
  },
  {
    prefix: "tck-artifact-data",
    plan: {
      kind: "complete-with-artifacts",
      summary: "generated data artifact",
      artifacts: [
        {
          artifactId: "tck-artifact-data",
          name: "data-artifact",
          parts: [{ data: { key: "value", count: 42 } }],
        },
      ],
    },
  },
  {
    prefix: "tck-message-response",
    plan: { kind: "direct-message", text: "Direct message response" },
  },
  {
    // Terminal-task prerequisite: the TCK's create_completed_task helper
    // expects the SendMessage response itself to show a completed task.
    prefix: "tck-complete-task",
    plan: { kind: "complete-with-message", summary: "Hello from TCK" },
  },
];

/**
 * Match an A2A messageId against the conformance conventions. Longest-prefix
 * first so `tck-artifact-file-url` wins over `tck-artifact-file`. Returns null
 * for ordinary messages (default echo behavior).
 */
export function matchDefaultAgentConvention(messageId: string | undefined): DefaultAgentConvention | null {
  if (!messageId) return null;
  const sorted = [...CONVENTIONS].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const { prefix, plan } of sorted) {
    if (messageId.startsWith(prefix)) return plan;
  }
  return null;
}
