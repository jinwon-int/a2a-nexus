# A2A Nexus Conformance

A2A Nexus includes a public-safe local conformance runner for checking the core contract fixtures without connecting to a production broker or using operator credentials.

## Command

```sh
npm run test:conformance
```

The command runs the stable local conformance allowlist in `test/conformance/run-conformance.mjs` and exits non-zero if any check fails.

## Machine-readable output

For CI systems or wrapper tools:

```sh
npm --silent run test:conformance -- --json
```

The JSON output uses schema version `a2a-nexus-conformance.v1`:

```json
{
  "schemaVersion": "a2a-nexus-conformance.v1",
  "ok": true,
  "total": 10,
  "passed": 10,
  "failed": 0,
  "durationMs": 1234,
  "exitCode": 0,
  "checks": [
    {
      "name": "check-contract-fixtures.mjs",
      "status": "pass",
      "exitCode": 0,
      "durationMs": 100
    }
  ],
  "safety": {
    "sourceOnly": true,
    "noLive": true,
    "productionBrokerRequired": false,
    "providerSend": false,
    "telegramSend": false,
    "databaseMutation": false,
    "terminalAckReplay": false,
    "deployOrRestart": false,
    "secretRequired": false
  }
}
```

## Check allowlist

List the current public-safe check set:

```sh
npm run test:conformance -- --list
```

The allowlist intentionally includes only local fixture/contract validators. Planning, release go/no-go, live-dispatch, deploy, broker mutation, Terminal Brief ACK/replay, and package publication surfaces are excluded from this command.

## Safety boundary

`test:conformance` is local and no-live. It must not:

- require a production broker URL or edge secret;
- create broker tasks;
- deploy or restart Gateway, broker, or worker services;
- mutate production databases or terminal outboxes;
- send provider or Telegram messages;
- ACK or replay Terminal Brief records;
- rotate, move, disclose, or write secrets;
- publish packages, create releases/tags, or change repository visibility.

This runner verifies A2A Nexus local contract/fixture conformance. It is not, by itself, a claim that a third-party runtime passed the official Agent2Agent SDK/TCK or that any publication/release approval has been granted.

## Typical CI use

```yaml
- run: npm ci --ignore-scripts --include=dev
- run: npm run test:conformance
- run: npm --silent run test:conformance -- --json > conformance-summary.json
```
