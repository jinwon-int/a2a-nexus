// Shared value guards and the no-live approval-sensitive action list used across
// the terminal-brief sidecar modules.
//
// These were previously copied byte-for-byte into many terminal-brief-*.ts
// files. `approvalSensitiveActionsExcluded` in particular encodes the no-live
// safety boundary; keeping a single source prevents the copies from drifting
// apart. Modules whose helpers genuinely differ (state-specific title/state/
// blocker maps) keep their own local versions and do not import from here.

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function approvalSensitiveActionsExcluded(): string[] {
  return [
    "sending the approval request",
    "granting approval or executing an approval grant",
    "dispatching or invoking a start executor",
    "spawning a process or starting/stopping the sidecar",
    "Terminal Brief default-on enablement",
    "live provider/Hermes/mobilealpha/Telegram/OpenClaw send",
    "terminal ACK/replay or terminal receipt DB mutation",
    "GitHub PR merge, issue close, or comment post from the packet/route",
    "TaskFlow record creation or broker DB mutation",
    "production deploy/restart, historical replay, release, publish, or secret movement",
  ];
}
