# A2A agent-card discovery

This repository publishes a local/development agent-card fixture at
[`docs/a2a-agent-card.local.json`](./a2a-agent-card.local.json). The card is a
safe, static discovery example for the OpenClaw A2A plugin boundary. It is meant
for local integrations, conformance checks, and community documentation while the
plugin remains alpha.

## Production exposure is opt-in

The plugin must not expose a live production agent card by default. Operators who
want a public or network-visible discovery document should explicitly enable and
serve one from their OpenClaw/Gateway deployment after reviewing the values for
that environment.

When publishing a production card:

- use the deployment's public, intended endpoint shape only;
- do not include tokens, session cookies, private hostnames, internal IP ranges,
  raw broker URLs, live operator identifiers, or local filesystem paths;
- describe auth schemes generically, for example `Authorization: Bearer <token>`
  or gateway-authenticated sessions, without secret values;
- mark alpha/compatibility limitations clearly;
- keep operator events, streaming, and push notification claims aligned with the
  deployment's explicit configuration.

## Declared protocol profile

The local fixture declares the plugin as an alpha OpenClaw adapter targeting A2A
1.0 discovery conventions while retaining A2A 0.3 task-lifecycle compatibility
and OpenClaw-specific extension fields. The plugin-owned boundary is documented
in [`docs/protocol.md`](./protocol.md).

## Capability flags

The fixture declares these supported capability flags:

- `send` — create broker-backed delegated tasks through `a2a.task.request`.
- `status` — project broker task status through `a2a.task.status`.
- `cancel` — map OpenClaw cancellation requests to broker cancel fan-out.
- `list` — document the expected task-list discovery shape for deployments that
  expose broker task listing.
- `streaming` — opt-in operator event stream projection.
- `pushNotifications` — opt-in terminal operator notification delivery.
- `artifacts` — sanitized artifact links and evidence projection; inline binary
  payloads are not advertised.
- `githubEvidenceProjection` — sanitized GitHub merge-gate/evidence summaries
  only, never raw GitHub API responses or tokens.
- `taskDelegation` — OpenClaw-to-broker delegated task lifecycle support.

## Skills

The local card names four plugin skills:

1. task delegation;
2. status lookup;
3. cancellation;
4. GitHub evidence projection.

These skills intentionally describe the plugin boundary, not the broker control
plane or Docker runner internals.

## Companion worker example: TweetClaw

Do not add product-specific capabilities to the repository's local fixture
unless this plugin owns them. A production card for a worker node can advertise
capabilities supplied by installed companion OpenClaw plugins. For example, a
node with TweetClaw installed can expose an `x-twitter.automation` skill:

```bash
openclaw plugins install @xquik/tweetclaw
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

Example public-safe skill fragment:

```json
{
  "id": "x-twitter.automation",
  "name": "X/Twitter automation",
  "description": "Use TweetClaw for tweet search, reply search, follower export, user lookup, posting and replies, media upload/download, direct messages, monitors, webhooks, and giveaway draws. Visible actions require OpenClaw approval."
}
```

Keep the A2A plugin's own card focused on task delegation, status, cancellation,
and GitHub evidence projection. Put TweetClaw credentials only in TweetClaw
config or environment variables on the worker node, never in the agent card,
broker payloads, or fixture.

## Local fixture endpoint shape

The fixture uses loopback example URLs:

```text
http://127.0.0.1:3000/.well-known/agent-card.json
http://127.0.0.1:3000/a2a
```

They are placeholders for local development and tests. Replace them only in an
operator-reviewed deployment-specific card.
