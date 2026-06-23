# Gateway config bridge — operatorEvents/notification

Issue:  jinwon-int/plugin-a2a#269
Parent: jinwon-int/a2a-plane#241
Run:    terminal-brief-activation-20260511T080211Z

The Gateway config bridge provides a safe, auditable mechanism for injecting
`operatorEvents.enabled` + `notification.enabled` settings into the
`a2a-broker-adapter` plugin config. It always follows the
**backup → apply → verify → rollback-on-fail** pattern.

## Safety

- **Plugin-level config only** — never touches core Gateway configuration.
- **Backup before apply** — snapshot captured before any mutation.
- **Verify after apply** — structural and semantic checks run post-apply.
- **Rollback on failure** — exact pre-snapshot state restored automatically.
- **No live provider send** — config bridge is configuration-only.
- **No Gateway restart** — bridge operation does not trigger restarts.

## Quick start

```typescript
import {
  applyGatewayConfigBridgeSafe,
  buildOperatorNotificationConfigTemplate,
} from "@jinwon-int/plugin-a2a/gateway-config-bridge";

const config = {
  plugins: {
    entries: {
      "a2a-broker-adapter": {
        enabled: true,
        config: { baseUrl: "https://broker.example.com" },
      },
    },
  },
};

const result = applyGatewayConfigBridgeSafe(
  config,
  buildOperatorNotificationConfigTemplate("telegram", "operator-chat"),
);

if (result.ok) {
  console.log("✅ Config applied:", result.diff);
  // result.config is now ready for Gateway consumption
} else {
  console.error("❌ Config rejected:", result.reason);
  // result.config has been rolled back to original state
}
```

## API

### `applyGatewayConfigBridgeSafe(config, settings)`

The primary entry point. Performs the full safe-apply cycle:

1. Takes a deep-copy backup of the plugin entry.
2. Applies the requested `operatorEvents` / `notification` settings.
3. Validates the resulting config.
4. On failure: restores from backup and returns a failure result.
5. On success: returns the updated config with diff and backup.

Returns `A2AGatewayConfigBridgeResult` (union of success/failure).

### `createGatewayConfigBackup(config)`

Creates a snapshot of the current plugin entry state. The snapshot can be
restored later with `restoreGatewayConfigFromBackup()`.

### `restoreGatewayConfigFromBackup(config, snapshot)`

Restores the plugin entry to the exact state captured in the snapshot.
Always safe — purely structural restoration.

### `applyGatewayConfigBridge(config, settings)`

Direct-apply (no backup/rollback). For use when the caller manages safety.

### `diffGatewayConfigs(before, after)`

Produces human-readable diff lines between pre-apply backup and post-apply
config.

### `validateConfigBridgeApplication(config, settings)`

Runs structural and semantic checks against the post-apply config. Returns
a list of `A2AGatewayConfigBridgeCheck` objects.

### Template builders

- `buildOperatorNotificationConfigTemplate(channel, to)` — Full notification
  template with `operatorEvents.enabled=true`, `notification.enabled=true`,
  and channel/target.
- `buildOperatorEventsOnlyTemplate()` — Enables operator events but keeps
  notification disabled. Useful as a staging step.

## Config bridge settings

| Field | Type | Description |
|---|---|---|
| `operatorEventsEnabled` | `boolean` | Enable the operator event bridge |
| `notificationEnabled` | `boolean` | Enable operator notification delivery |
| `notificationChannel` | `string` | Destination channel (e.g. `telegram`) |
| `notificationTo` | `string` | Destination target |
| `notificationAccountId` | `string?` | Optional channel account id |
| `notificationThreadId` | `string \| number?` | Optional thread/topic id |

## Verification checks

The bridge validates:

| Code | What it checks |
|---|---|
| `plugin_entry_present` | Plugin entry exists in `plugins.entries` |
| `plugin_enabled` | Plugin entry `enabled` is `true` |
| `operator_events_block_exists` | `operatorEvents` block is present |
| `operator_events_enabled_match` | `operatorEvents.enabled` matches request |
| `notification_enabled` | `notification.enabled` matches request |
| `notification_channel` | `notification.channel` matches request |
| `notification_to` | `notification.to` matches request |
| `resolved_operator_events_enabled` | `resolveA2ABrokerAdapterPluginConfig` confirms activation |

## Local verification

```bash
npm run build
node --test test/gateway-config-bridge.test.mjs
scripts/canary-receipt-gated-preflight.sh
```

## Related

- [Operator notification adapter](./operator-terminal-notification-receipts.md)
- [Canary receipt-gated runtime preflight](./canary-receipt-gated-runtime-preflight.md)
- [openclaw.plugin.json](../openclaw.plugin.json) — Plugin config schema
