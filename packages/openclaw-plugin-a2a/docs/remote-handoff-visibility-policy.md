# Remote handoff visibility and policy guard

The plugin-side `sessions_send` remote-resolution path now applies a local visibility-policy guard before delegating a bare node id to the A2A broker. This keeps operator-visible decisions in the plugin even when OpenClaw core has not yet loaded a local session for the target.

## Operator-safe defaults

- Bare node ids such as `node-alpha` are treated as remote A2A targets; local session keys containing `:` remain local.
- Deny rules win over allow rules.
- If an allowlist is configured for targets, task kinds, or workspaces, values outside the allowlist are surfaced as `policy_denied` and the inner dispatch is not called.
- Live-impact handoffs require explicit approval by default when request metadata carries `policyContext.requiresApproval`, `policyContext.liveImpact`, or `policyContext.targetEnvironment: "live"`.
- Missing remote target resolution is surfaced as `missing_target` instead of falling through to an ambiguous local-session failure.
- Guard exceptions are mapped to `error` visibility results, preserving the remote target when known.

Example plugin config:

```json
{
  "plugins": {
    "entries": {
      "a2a-broker-adapter": {
        "enabled": true,
        "config": {
          "baseUrl": "https://broker.example",
          "remoteHandoff": {
            "allowedTargets": ["node-alpha", "node-beta", "node-gamma", "node-delta"],
            "deniedTargets": ["node-quarantine"],
            "allowedTaskKinds": ["chat", "propose_patch", "validate_change"],
            "allowedWorkspaces": ["plugin-a2a"],
            "approvalRequiredTaskKinds": ["apply_local_change", "promote_to_live", "rollback_live"],
            "requireApprovalForLiveImpact": true
          }
        }
      }
    }
  }
}
```

## Visibility mapping

| Decision | Surface value | Operator meaning |
| --- | --- | --- |
| Allowed | `remote_handoff_allowed` | Target, task kind, and workspace passed plugin policy; broker dispatch may proceed. |
| Denied | `policy_denied` | Plugin policy blocked the handoff before broker dispatch. |
| Missing target | `missing_target` | No remote node id was resolvable from display/session keys. |
| Approval required | `approval_required` | A live-impact or explicitly gated handoff needs human approval first. |
| Error | `error` | Guard evaluation failed; do not silently delegate. |

## Coordinated release trigger

Release this with the broker semantics that treat `policy_denied` as an operator-visible non-dispatch outcome and with the OpenClaw `sessions_send` remote-resolution contract that preserves bare node ids before local-session visibility checks. Coordinate the plugin release with any broker/core deployment that changes these status names so dashboards and issue automation continue to correlate the same decision strings.

Suggested pre-release checks:

1. Run the focused handoff guard test file.
2. Run the full plugin test suite with `npm test`.
3. Smoke one allowed remote handoff and one denied handoff in staging, confirming the denied path creates no broker task.

## Post-merge regression canary

After merging changes that touch `sessions_send`, broker dispatch, or node-id resolution, verify these exact surfaces before release:

- `target.displayKey: "node-alpha"` with a local-shaped `target.sessionKey` still resolves as the remote node `node-alpha` from `displayKey`.
- `target.sessionKey: "node-alpha"` is used as the remote fallback when `displayKey` is absent or local-shaped.
- A disabled or unconfigured broker adapter returns `policy_denied` with reason `remote node-id requires A2A adapter` after policy evaluation allows the target.
- Policy-denied, approval-required, and guard-error decisions return `handled: false`, do not call broker dispatch, and preserve the stable `visibility` values above.
