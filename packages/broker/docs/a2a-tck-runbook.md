# A2A TCK runbook — measuring conformance against the official kit

The [official A2A Technology Compatibility Kit](https://github.com/a2aproject/a2a-tck)
(`a2aproject/a2a-tck`) is a pytest-based conformance suite for A2A
implementations with RFC 2119 MUST/SHOULD/MAY categorization and HTML/JSON
compliance reports. This runbook wires it to the broker as an **opt-in
measurement lane** — like `refresh:drift-refs`, it is run by maintainers on
demand, not by default CI.

## Why a measurement lane, not a release gate

The broker is an *A2A 1.0-compatible alpha profile* with documented
deviations (see `src/fixtures/a2a-protocol-compatibility.ts`): REST and gRPC
transports are unsupported, push notification config methods are not
implemented, and 0.3 compatibility mode is intentionally absent. Some
mandatory TCK tests are therefore **expected to fail today**. The value of
the TCK here is a measured, versioned compliance report — claims about spec
compatibility come from the official kit's output, not self-assertion.

When the deviation set shrinks (e.g. push notification CRUD lands), re-run
the TCK and check the report delta. Promote categories to a CI gate only
once they are stably green.

## Quick self-check (no Python required)

```bash
cd packages/broker
npm run tck:self-check
```

Boots an ephemeral loopback broker (temp state file, no live surfaces),
probes `/.well-known/agent-card.json` and the JSON-RPC `ListTasks` method,
and exits. This is the harness's own health check and is safe to run
anywhere.

## Full TCK run

```bash
# one-time setup
git clone https://github.com/a2aproject/a2a-tck
cd a2a-tck && pip install -e . && cd -

# run the mandatory category against a fresh local broker
cd packages/broker
A2A_TCK_DIR=/path/to/a2a-tck npm run tck:run -- --category mandatory
```

Categories (per the TCK):

| Category | Meaning |
| --- | --- |
| `mandatory` | A2A compliance validation (MUST requirements) |
| `capabilities` | Conditional-mandatory based on agent-card declarations |
| `quality` | Production-readiness checks |
| `features` | Optional behaviors |

Reports are written by the TCK into its own output directory; attach the
JSON/HTML report to the round evidence when citing compliance numbers.

## Safety

The harness binds loopback only, uses an ephemeral temp state file, disables
the stale reaper, and performs no live sends, deploys, terminal ACKs, or DB
mutations. It is source-only measurement.

## Interactive debugging

For ad-hoc inspection of the broker's A2A surface (agent card rendering,
message sending, task views), the official
[a2a-inspector](https://github.com/a2aproject/a2a-inspector) debug UI can be
pointed at a locally started broker (`npm run start:local`). Treat it as a
developer tool — it is not part of any gate.
