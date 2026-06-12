# Fleet Routing Guard

A pure-offline preflight that enforces fleet worker routing before a rollout is
declared healthy:

- **Team1 → `seoseo` broker**
- **Team2 → `gwakga` broker**

It exists because, during a fleet rollout, routing drifted: some workers ran the
old `openclaw-a2a-worker` service instead of `a2a-hermes-worker`, node `yukson`
used `/opt/openclaw-a2a-worker` instead of `/opt/a2a-broker-worker`, Team2 was
briefly mispointed at the `seoseo` broker, and `EDGE_SECRET` mismatches silently
left workers polling the wrong broker.

The guard validates **operator-collected evidence**. It runs no live SSH, opens
no network connections, restarts nothing, and never handles raw secrets — only
sha256 fingerprints.

## Usage

```bash
npm run fleet:routing-guard -- --expected inventory.json --observed observed.json
# JSON output:
npm run fleet:routing-guard -- --expected inventory.json --observed observed.json --json
# Downgrade violations to warnings (still loudly marked):
npm run fleet:routing-guard -- --expected inventory.json --observed observed.json --force
# Print the per-node collection one-liner (does NOT execute anything):
npm run fleet:routing-guard -- collect
```

## Input schemas

### `--expected <file>` — declarative routing inventory

```json
{
  "teams": {
    "team1": { "broker": "seoseo", "brokerUrl": "https://seoseo.broker.internal", "edgeSecretSha256": "<64-hex>" },
    "team2": { "broker": "gwakga", "brokerUrl": "https://gwakga.broker.internal", "edgeSecretSha256": "<64-hex>" }
  },
  "nodes": {
    "yukson":   { "team": "team1" },
    "bangtong": { "team": "team1" },
    "soonwook": { "team": "team2", "exemptRoot": true }
  },
  "expectedService": "a2a-hermes-worker",
  "expectedRoot": "/opt/a2a-broker-worker",
  "expectedRevision": "<git-sha>"
}
```

- `teams.<team>.edgeSecretSha256` is the sha256 hex digest of that team's edge
  secret. Raw secrets are never recorded here.
- `nodes.<node>.team` must reference a defined team.
- `nodes.<node>.exemptRoot: true` skips the ExecStart-root check for nodes that
  legitimately run from a non-standard path.

### `--observed <file>` — per-node observed state

An array of entries, one per node, produced by the `collect` one-liner:

```json
[
  {
    "node": "yukson",
    "brokerUrl": "https://seoseo.broker.internal",
    "edgeSecretSha256": "<64-hex>",
    "service": "a2a-hermes-worker",
    "root": "/opt/a2a-broker-worker",
    "revision": "<git-sha>",
    "active": true
  }
]
```

`edgeSecretSha256` is the sha256 of the secret as observed on the node — never
the raw value.

## Collect workflow

1. On each fleet node, run the one-liner printed by `npm run fleet:routing-guard -- collect`.
   It reads the systemd unit name, ExecStart root, `BROKER_URL`, the sha256 of
   the edge secret env var, `dist/build-info.json` revision, and
   `systemctl is-active` — then prints one observed-state JSON object.
   Printing the command is allowed; the guard never executes it remotely.
2. Concatenate the per-node objects into a JSON array → `observed.json`.
3. Run the guard with `--expected` and `--observed`.

## Exit-code contract

The guard exits **0 only when every node** matches its team's:

- broker URL (trailing slashes are normalized),
- edge-secret sha256 fingerprint,
- service name (`expectedService`),
- ExecStart root (`expectedRoot`, unless the node is `exemptRoot`),
- build revision (`expectedRevision`), and
- `active === true`.

Any mismatch → **exit 1**, with each violation enumerated by node and field
(fail-closed). A node present in the inventory but missing from the observed
list is itself a violation. Malformed inputs → exit 1 with `MALFORMED-INPUT`.

## `--force` semantics

`--force` downgrades violations to warnings and exits **0**, but the output is
loudly marked `FORCED-PAST-VIOLATIONS`. It is an explicit, auditable override —
not a way to hide drift. `--force` does **not** bypass malformed-input failures.
