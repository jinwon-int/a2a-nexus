# External Harness Quickstart

This guide is for any agent harness that wants to integrate with A2A Nexus safely — Claude Code, Codex, Hermes, piri, OpenClaw, or one you write yourself. No harness is privileged; they all meet the broker through the same contract. The path is no-live by default: it uses loopback broker URLs, checked-in fixtures, and local conformance checks only.

OpenClaw is the first/reference integration, not a required dependency. A Hermes-style agent, a local worker daemon, or another public harness can use the same A2A task lifecycle and Terminal Brief receipt boundaries without calling OpenClaw CLI commands.

## Safety Boundary

Do not use this path with production brokers, live provider transports, Telegram accounts, terminal outboxes, production databases, or private secrets.

Do not perform these actions from the quickstart:

- production deploy
- Gateway, broker, worker, or sidecar restart
- live provider, Telegram, Hermes, or OpenClaw message send
- terminal ACK or replay
- database mutation, prune, migration, or historical replay
- release, tag, npm publish, or public announcement
- credential movement or secret disclosure

Provider accepted, provider sent, queue accepted, and provider message id are accepted-send evidence only. They are not requester-visible receipt, operator-visible receipt, human-seen proof, or terminal ACK.

## 1. Install And Run The No-Live Checks

From repository root:

~~~bash
npm ci --ignore-scripts --include=dev
npm run check:external-harness-conformance
~~~

The check is read-only. It validates this guide, the no-live fixture, and the public safety boundary. It does not contact a live broker or provider.

## 2. Inspect The Fixture

The canonical fixture is:

~~~text
fixtures/external-harness/no-live-conformance.json
~~~

It describes the minimum public contract for an external harness:

- register or advertise a worker id
- accept a task idempotently
- produce terminal evidence as Done or Block
- keep provider-send evidence non-ACK
- optionally emit Terminal Brief receipt evidence

All URLs in the fixture are loopback placeholders. Replace them only in a private deployment plan after approval; do not commit real endpoints or secrets.

## 3. Worker Lifecycle Contract

An external harness should treat A2A work as a durable task lifecycle:

1. Register or advertise a worker id and capabilities.
2. Poll or receive a task from the broker.
3. Claim/start the task once.
4. Execute idempotently.
5. Report one terminal result: Done or Block.
6. Preserve evidence links and short summaries without leaking secrets.

Replay safety is required. A duplicate task id must return the same terminal result or a clear Block, not duplicate side effects.

The dispatcher side of that contract is observable too (#2010): `POST /tasks` is
idempotent on a client-supplied id. When the id already exists, the broker
returns the stored record unchanged and marks the response with
`idempotentReturn: true` (HTTP 200, versus 201 for a fresh create) plus a
`task.create_idempotent_hit` audit event. Treat a marked response as
"already exists" — never count it as a new create.

## 4. Terminal Brief Adapter Contract

Terminal Brief delivery is harness-neutral. An external harness can provide an adapter process that accepts one Terminal Brief envelope on stdin and returns one JSON receipt decision on stdout.

ACK-eligible receipt decisions are limited to:

~~~json
{
  "ackTerminalEvent": true,
  "confirmationSource": "current_session_visible",
  "receiptId": "external-harness-visible-receipt"
}
~~~

~~~json
{
  "ackTerminalEvent": true,
  "confirmationSource": "manual_operator_receipt",
  "receiptId": "manual-operator-receipt"
}
~~~

Everything else should fail closed:

~~~json
{
  "ackTerminalEvent": false,
  "terminalReceiptStatus": "produced",
  "receiptId": "external-harness-spool-id",
  "reason": "operator-visible receipt is not confirmed"
}
~~~

Provider accepted, provider sent, queue accepted, and spool produced can be useful progress evidence, but they must not ACK terminal-outbox rows.

## 5. Final Count And Broker Closeout

Terminal Brief messages may contain a final count such as `(3/3)`. A final `(N/N)` message is a useful closeout signal, but it is not an irreversible action by itself.

Expected future behavior is tracked separately:

- `jinwon-int/a2a-broker#689`: broker watches Terminal Brief completion evidence and prepares next-step packets.
- `jinwon-int/a2a-broker#690`: broker prepares a closeout candidate when final `(N/N)` evidence arrives.

The broker may prepare closeout evidence, missing-worker lists, and follow-up task candidates. It must not automatically merge PRs, close issues, perform live sends, replay ACKs, restart services, mutate databases, or publish releases.

## 6. Required Local Gate

Before opening a PR that changes public harness docs or fixtures, run:

~~~bash
npm run check:external-harness-conformance
npm run check:quickstart-conformance
npm run scan:public-readiness
~~~

For source changes, run the broader release gate as appropriate:

~~~bash
npm run check
~~~

## Public Evidence Checklist

Before sharing evidence publicly, confirm:

- no live send or provider transport occurred
- no terminal ACK or replay occurred
- no production broker, Gateway, worker, sidecar, or database was touched
- no private endpoint, token, provider id, Telegram id, raw transcript, or host-specific path appears
- accepted-send evidence is labeled non-ACK
- final `(N/N)` evidence is labeled closeout input, not automatic approval
