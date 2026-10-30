import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTerminalBriefTeamScope,
  resolveTerminalBriefParentOriginRoute,
  TERMINAL_BRIEF_PARENT_ORIGIN_METADATA_FIELDS,
} from "./terminal-brief-routing.js";

function expectRoute(input: Parameters<typeof resolveTerminalBriefParentOriginRoute>[0]) {
  const result = resolveTerminalBriefParentOriginRoute(input);
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  return result.route;
}

test("normalizes Terminal Brief team scopes", () => {
  assert.equal(normalizeTerminalBriefTeamScope("team1"), "team1-only");
  assert.equal(normalizeTerminalBriefTeamScope("Team1 only"), "team1-only");
  assert.equal(normalizeTerminalBriefTeamScope("team1-only"), "team1-only");
  assert.equal(normalizeTerminalBriefTeamScope("team2"), "team2-only");
  assert.equal(normalizeTerminalBriefTeamScope("team1+team2"), "team1+team2");
  assert.equal(normalizeTerminalBriefTeamScope("team2+team1"), "team1+team2");
  assert.equal(normalizeTerminalBriefTeamScope("both"), "team1+team2");
  assert.equal(normalizeTerminalBriefTeamScope("unknown"), undefined);
});

test("case 1: brokeralpha initiates Team1-only local Terminal Brief", () => {
  const route = expectRoute({ initiatingBrokerId: "brokeralpha", requestedTeamScope: "team1-only" });
  assert.equal(route.initiatingBrokerId, "brokeralpha");
  assert.equal(route.requestedTeamScope, "team1-only");
  assert.equal(route.parentBrokerId, "brokeralpha");
  assert.equal(route.originBrokerId, "brokeralpha");
  assert.equal(route.operatorFacingTerminalBriefSender, "brokeralpha");
  assert.deepEqual(route.localTeamIds, ["team1"]);
  assert.equal(route.handoff, null);
  assert.equal(route.executionPath, "local-only");
  assert.equal(route.childProjectionRequired, false);
  assert.equal(route.parentSeedRequired, false);
  assert.equal(route.notification.parentBrokerOnly, true);
  assert.equal(route.notification.childLocalNotificationSuppressedAfterRelaySuccess, false);
  assert.equal(route.notification.relayFailureFallsBackToLocalNotification, false);
});

test("case 2: brokeralpha initiates Team1+Team2 with brokerbeta child projections back to brokeralpha", () => {
  const route = expectRoute({ initiatingBrokerId: "brokeralpha", requestedTeamScope: "team1+team2" });
  assert.equal(route.parentBrokerId, "brokeralpha");
  assert.equal(route.originBrokerId, "brokeralpha");
  assert.equal(route.operatorFacingTerminalBriefSender, "brokeralpha");
  assert.deepEqual(route.localTeamIds, ["team1"]);
  assert.deepEqual(route.handoff, {
    handoffBrokerId: "brokerbeta",
    handoffTeamIds: ["team2"],
    projectionDestinationBrokerId: "brokeralpha",
  });
  assert.equal(route.executionPath, "local-plus-cross-team-child-projection");
  assert.equal(route.childProjectionRequired, true);
  assert.equal(route.parentSeedRequired, true);
  assert.equal(route.notification.childLocalNotificationSuppressedAfterRelaySuccess, true);
  assert.equal(route.notification.relayFailureFallsBackToLocalNotification, true);
});

test("case 3: brokerbeta initiates Team2-only local Terminal Brief", () => {
  const route = expectRoute({ initiatingBrokerId: "brokerbeta", requestedTeamScope: "team2-only" });
  assert.equal(route.initiatingBrokerId, "brokerbeta");
  assert.equal(route.parentBrokerId, "brokerbeta");
  assert.equal(route.originBrokerId, "brokerbeta");
  assert.equal(route.operatorFacingTerminalBriefSender, "brokerbeta");
  assert.deepEqual(route.localTeamIds, ["team2"]);
  assert.equal(route.handoff, null);
  assert.equal(route.executionPath, "local-only");
  assert.equal(route.childProjectionRequired, false);
  assert.equal(route.parentSeedRequired, false);
});

test("case 4: brokerbeta initiates Team1+Team2 with brokeralpha child projections back to brokerbeta", () => {
  const route = expectRoute({ initiatingBrokerId: "brokerbeta", requestedTeamScope: "both" });
  assert.equal(route.parentBrokerId, "brokerbeta");
  assert.equal(route.originBrokerId, "brokerbeta");
  assert.equal(route.operatorFacingTerminalBriefSender, "brokerbeta");
  assert.deepEqual(route.localTeamIds, ["team2"]);
  assert.deepEqual(route.handoff, {
    handoffBrokerId: "brokeralpha",
    handoffTeamIds: ["team1"],
    projectionDestinationBrokerId: "brokerbeta",
  });
  assert.equal(route.executionPath, "local-plus-cross-team-child-projection");
  assert.equal(route.childProjectionRequired, true);
  assert.equal(route.parentSeedRequired, true);
  assert.equal(route.notification.childLocalNotificationSuppressedAfterRelaySuccess, true);
  assert.equal(route.notification.relayFailureFallsBackToLocalNotification, true);
});

test("Team2-only work cannot accidentally route through brokeralpha", () => {
  const result = resolveTerminalBriefParentOriginRoute({ initiatingBrokerId: "brokeralpha", requestedTeamScope: "team2-only" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "team_scope_not_owned_by_initiator");
  assert.match(result.reason, /Team2-only/);
});

test("Team1-only work cannot accidentally route through brokerbeta", () => {
  const result = resolveTerminalBriefParentOriginRoute({ initiatingBrokerId: "brokerbeta", requestedTeamScope: "team1-only" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "team_scope_not_owned_by_initiator");
  assert.match(result.reason, /Team1-only/);
});

test("all resolved routes preserve no-live and non-ACK safety boundaries", () => {
  for (const [initiatingBrokerId, requestedTeamScope] of [
    ["brokeralpha", "team1-only"],
    ["brokeralpha", "team1+team2"],
    ["brokerbeta", "team2-only"],
    ["brokerbeta", "team1+team2"],
  ] as const) {
    const route = expectRoute({ initiatingBrokerId, requestedTeamScope });
    assert.deepEqual(route.requiredMetadataFields, TERMINAL_BRIEF_PARENT_ORIGIN_METADATA_FIELDS);
    assert.equal(route.safety.liveProviderSend, false);
    assert.equal(route.safety.terminalOutboxAckMutated, false);
    assert.equal(route.safety.terminalAckReplay, false);
    assert.equal(route.safety.operatorApprovalInferred, false);
    assert.equal(route.parentBrokerId, route.initiatingBrokerId);
    assert.equal(route.originBrokerId, route.initiatingBrokerId);
    assert.equal(route.operatorFacingTerminalBriefSender, route.initiatingBrokerId);
  }
});

test("unknown broker and unsupported scope fail closed", () => {
  const unknownBroker = resolveTerminalBriefParentOriginRoute({ initiatingBrokerId: "unknown", requestedTeamScope: "team1-only" });
  assert.equal(unknownBroker.ok, false);
  assert.equal(unknownBroker.code, "unknown_initiating_broker");

  const badScope = resolveTerminalBriefParentOriginRoute({ initiatingBrokerId: "brokeralpha", requestedTeamScope: "team3" });
  assert.equal(badScope.ok, false);
  assert.equal(badScope.code, "unsupported_team_scope");
});
