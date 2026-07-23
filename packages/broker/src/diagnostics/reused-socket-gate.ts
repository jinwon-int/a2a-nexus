// Reused-socket stall classifier, extracted from server.ts. Given aggregate and
// per-class request-timing snapshots, it attributes an observed request stall to
// a dominant bucket (reused-socket idle, fresh-socket accept/read, Node
// request-event delivery, client-pool artifact, ...) with a confidence and
// supporting evidence. Pure: it reads only the supplied snapshots.
import type { RequestTimingWindow } from "./request-timing-window.js";

/**
 * Operator gate classifier for reused-socket idle vs. client pool vs. Node delivery.
 *
 * Uses aggregate timing windows from /schedz to distinguish:
 *   1. Reused-socket idle on wire (high reusedSocketIdleBeforeHttpRequestEventMs)
 *   2. Client pool artifact (high clientProbeStartToHttpRequestEventMs while server idle is low)
 *   3. Node request-event delivery delay (high httpRequestEventToHandlerStartMs)
 *   4. Server handler time (high schedulingTiming relates to handler side)
 *
 * Since #1102, "accepted-socket-waiting-before-handler" is split into:
 *   - "accepted-socket-waiting-before-request-event": dominant delay is
 *     TCP accept / TLS handshake / read before the HTTP parser fires.
 *   - "accepted-socket-waiting-before-handler": dominant delay is
 *     Node request-event → handler start (event-loop descheduling).
 *
 * Since #1121, the reused-socket branch is similarly split:
 *   - "reused-socket-idle-before-request-event": dominant delay is
 *     keep-alive idle on wire before the HTTP request event fires.
 *   - "reused-socket-waiting-before-handler": dominant delay is
 *     Node request-event → handler start on a reused socket.
 *
 * Returns a verdict object with bucket, confidence, and evidence fields.
 */
export function computeReusedSocketGate(inputs: {
  freshSocketAge: ReturnType<RequestTimingWindow["snapshot"]>;
  freshSocketAcceptToReq: ReturnType<RequestTimingWindow["snapshot"]>;
  freshHttpReqEventToHandler: ReturnType<RequestTimingWindow["snapshot"]>;
  freshSocketConnectedToFirstData: ReturnType<RequestTimingWindow["snapshot"]>;
  freshSocketFirstDataToReq: ReturnType<RequestTimingWindow["snapshot"]>;
  reusedSocketIdle: ReturnType<RequestTimingWindow["snapshot"]>;
  aggHttpReqEventToHandler: ReturnType<RequestTimingWindow["snapshot"]>;
  aggClientProbeToHttpReqEvent: ReturnType<RequestTimingWindow["snapshot"]>;
  aggSocketIdleBeforeHttpReqEvent: ReturnType<RequestTimingWindow["snapshot"]>;
  aggSocketAgeBeforeHandler: ReturnType<RequestTimingWindow["snapshot"]>;
  reusedSocketAge: ReturnType<RequestTimingWindow["snapshot"]>;
  reusedSocketHttpReqEventToHandler: ReturnType<RequestTimingWindow["snapshot"]>;
  reusedSocketIdleBeforeData: ReturnType<RequestTimingWindow["snapshot"]>;
  reusedSocketDataToReqEvent: ReturnType<RequestTimingWindow["snapshot"]>;
}): {
  bucket: string;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  evidence: Record<string, number | null>;
} {
  const {
    freshSocketAcceptToReq,
    freshHttpReqEventToHandler,
    freshSocketConnectedToFirstData,
    freshSocketFirstDataToReq,
    reusedSocketIdle,
    aggHttpReqEventToHandler,
    aggClientProbeToHttpReqEvent,
    aggSocketIdleBeforeHttpReqEvent,
    freshSocketAge,
    reusedSocketAge,
    reusedSocketHttpReqEventToHandler,
    reusedSocketIdleBeforeData,
    reusedSocketDataToReqEvent,
  } = inputs;

  const reusedIdleP99 = reusedSocketIdle?.p99Ms ?? null;
  const eventToHandlerP99 = aggHttpReqEventToHandler?.p99Ms ?? null;
  const freshReqToHandlerP99 = freshHttpReqEventToHandler?.p99Ms ?? null;
  const freshConnectedToDataP99 = freshSocketConnectedToFirstData?.p99Ms ?? null;
  const freshDataToReqP99 = freshSocketFirstDataToReq?.p99Ms ?? null;
  const clientProbeToReqP99 = aggClientProbeToHttpReqEvent?.p99Ms ?? null;
  const globalIdleP99 = aggSocketIdleBeforeHttpReqEvent?.p99Ms ?? null;
  const freshAgeP99 = freshSocketAge?.p99Ms ?? null;
  const reusedAgeP99 = reusedSocketAge?.p99Ms ?? null;
  const reusedReqToHandlerP99 = reusedSocketHttpReqEventToHandler?.p99Ms ?? null;
  const freshAcceptToReqP99 = freshSocketAcceptToReq?.p99Ms ?? null;
  const reusedIdleBeforeDataP99 = reusedSocketIdleBeforeData?.p99Ms ?? null;
  const reusedDataToReqEventP99 = reusedSocketDataToReqEvent?.p99Ms ?? null;

  const reasons: string[] = [];
  let bucket = "no-significant-stall";
  let confidence: "low" | "medium" | "high" = "low";

  // Evidence: reused socket idle on wire
  if (reusedIdleP99 !== null && reusedIdleP99 > 1000) {
    reasons.push(`workerbeta: reused-socket idle on wire p99=${reusedIdleP99.toFixed(1)}ms`);
  }

  // Evidence: Node request-event delivery delay
  if (eventToHandlerP99 !== null && eventToHandlerP99 > 100) {
    reasons.push(`workerbeta: Node request-event delivery delay p99=${eventToHandlerP99.toFixed(1)}ms`);
  }

  // Evidence: client pool artifact (client sees delay but server idle is low)
  if (clientProbeToReqP99 !== null && globalIdleP99 !== null) {
    if (clientProbeToReqP99 > 1000 && globalIdleP99 < 500) {
      reasons.push(`workerbeta: client pool artifact — client→request=${clientProbeToReqP99.toFixed(1)}ms but server idle=${globalIdleP99.toFixed(1)}ms`);
    }
  }

  // Evidence: fresh connection age
  if (freshAgeP99 !== null && freshAgeP99 > 1000) {
    reasons.push(`workerbeta: fresh socket scheduling delay p99=${freshAgeP99.toFixed(1)}ms`);
  }

  // Evidence: accept→request-event breakdown for fresh sockets
  if (freshAcceptToReqP99 !== null && freshAcceptToReqP99 > 500) {
    reasons.push(`workerbeta: fresh socket accept→request-event p99=${freshAcceptToReqP99.toFixed(1)}ms`);
  }

  // Evidence: fresh-socket request-event → handler-start delay (event-loop descheduling)
  if (freshReqToHandlerP99 !== null && freshReqToHandlerP99 > 100) {
    reasons.push(`workerbeta: fresh socket req→handler delay p99=${freshReqToHandlerP99.toFixed(1)}ms`);
  }

  // Classify the dominant bucket
  if (reusedIdleP99 !== null && reusedIdleP99 > 1000) {
    // Split reused-socket stall into idle-before-request-event vs
    // waiting-before-handler (#1121).  Mirror the fresh socket split
    // but using the dedicated reused-socket event→handler window.
    // If idle-before-request-event dominates (>60% of total handler
    // wait or idle alone exceeds 2s), classify as idle on wire.
    // Otherwise the delay is in the req→handler dispatch phase.
    if (reusedReqToHandlerP99 !== null && reusedIdleP99 < reusedReqToHandlerP99 * 1.5 && reusedIdleP99 < 2000) {
      bucket = "reused-socket-waiting-before-handler";
      confidence = reusedReqToHandlerP99 > 500 ? "high" : "medium";
    } else if (reusedIdleBeforeDataP99 !== null && reusedDataToReqEventP99 !== null) {
      // Further split: distinguish wire idle from event-loop blocked
      // after data arrives (#1032 antithesis-runtime).
      // If idle-before-data dominates, the client wasn't sending —
      // the stall is client-pool or keep-alive race, not server-side.
      // If data-to-req-event dominates, data arrived but Node was
      // blocked (GC, cgroup throttle, event-loop pressure).
      if (reusedDataToReqEventP99 > reusedIdleBeforeDataP99 * 0.5 && reusedDataToReqEventP99 > 500) {
        bucket = "reused-socket-data-received-blocked";
        reasons.push(`workerzeta: reused-socket data→req-event p99=${reusedDataToReqEventP99.toFixed(1)}ms exceeds idle-before-data p99=${reusedIdleBeforeDataP99.toFixed(1)}ms — event-loop blocked after data arrived, not wire idle`);
        confidence = reusedDataToReqEventP99 > 2000 ? "high" : (reusedDataToReqEventP99 > 1000 ? "medium" : "low");
      } else {
        bucket = "reused-socket-idle-before-request-event";
        confidence = reusedIdleP99 > 3000 ? "high" : (reusedIdleP99 > 1500 ? "medium" : "low");
      }
    } else {
      bucket = "reused-socket-idle-before-request-event";
      confidence = reusedIdleP99 > 3000 ? "high" : (reusedIdleP99 > 1500 ? "medium" : "low");
    }
  } else if (eventToHandlerP99 !== null && eventToHandlerP99 > 100) {
    bucket = "node-request-event-delivery";
    confidence = eventToHandlerP99 > 500 ? "high" : "medium";
  } else if (clientProbeToReqP99 !== null && clientProbeToReqP99 > 1000 && (globalIdleP99 === null || globalIdleP99 < 500)) {
    bucket = "client-pool-artifact";
    confidence = "medium";
  } else if (freshAgeP99 !== null && freshAgeP99 > 1000) {
    // Split accepted-socket-waiting into accept→req vs. req→handler (#1102, #1125).
    // Use the fresh-socket accept→request-event window and the fresh-specific
    // httpRequestEventToHandlerStartMs window to distinguish TCP/accept wait
    // from event-loop descheduling.
    const freshAcceptToReqPortion = freshAcceptToReqP99 ?? 0;
    // Further decompose accept→req into accept→data (socket accepted but
    // no data arrived) vs. data→req (data arrived but event-loop blocked
    // before parser fired).  Uses fresh-connection breakdown windows that
    // separate "waiting for data on the wire" from "event-loop delay after
    // data arrived" (#1154 Team1 thesis — brokerbeta fresh >3s attribution).
    const freshConnectedToData = freshConnectedToDataP99 ?? 0;
    const freshDataToReq = freshDataToReqP99 ?? 0;
    // If the accept→req portion dominates (>60% of total fresh age or
    // accept→req alone exceeds the threshold), classify as TCP accept/read wait.
    if (freshAcceptToReqPortion > freshAgeP99 * 0.6 || freshAcceptToReqPortion > 1000) {
      // Further decompose: distinguish data-not-arrived from event-loop-blocked
      // after data arrived.  This is the key #1154 decomposition for fresh >3s.
      if (freshDataToReq > 500 && freshDataToReq > freshConnectedToData * 0.5) {
        // Data arrived but event-loop was blocked before HTTP parser ran.
        bucket = "accepted-socket-data-received-blocked";
        reasons.push(`workerzeta: fresh socket data→req-event p99=${freshDataToReq.toFixed(1)}ms exceeds connected→data p99=${freshConnectedToData.toFixed(1)}ms — Node event-loop blocked after data arrived`);
        confidence = freshDataToReq > 2000 ? "high" : (freshDataToReq > 1000 ? "medium" : "low");
      } else if (freshConnectedToData > 500 && freshConnectedToData > freshDataToReq * 0.5) {
        // Socket accepted but first data byte delayed — network latency,
        // brokerbeta didn't send yet, or host scheduling before read callback.
        bucket = "accepted-socket-waiting-for-data";
        reasons.push(`workerzeta: fresh socket connected→data p99=${freshConnectedToData.toFixed(1)}ms exceeds data→req-event p99=${freshDataToReq.toFixed(1)}ms — socket accepted but data not yet arrived`);
        confidence = freshConnectedToData > 2000 ? "high" : (freshConnectedToData > 1000 ? "medium" : "low");
      } else {
        // Unclear split; fall back to existing classification.
        bucket = "accepted-socket-waiting-before-request-event";
        confidence = freshAgeP99 > 3000 ? "high" : "medium";
      }
    } else {
      // Default: the delay is in the req→handler dispatch phase
      bucket = "accepted-socket-waiting-before-handler";
      confidence = freshAgeP99 > 3000 ? "high" : "medium";
    }
  }

  if (reasons.length === 0) {
    reasons.push("workerbeta: no stall evidence in aggregate timing windows");
  }

  return {
    bucket,
    confidence,
    reasons,
    evidence: {
      reusedSocketIdleP99Ms: reusedIdleP99,
      eventToHandlerP99Ms: eventToHandlerP99,
      freshHttpReqEventToHandlerP99Ms: freshReqToHandlerP99,
      clientProbeToReqP99Ms: clientProbeToReqP99,
      globalSocketIdleP99Ms: globalIdleP99,
      freshSocketAgeP99Ms: freshAgeP99,
      reusedSocketAgeP99Ms: reusedAgeP99,
      freshSocketAcceptToReqP99Ms: freshAcceptToReqP99,
      freshSocketConnectedToFirstDataP99Ms: freshConnectedToDataP99,
      freshSocketFirstDataToReqP99Ms: freshDataToReqP99,
      reusedSocketReqToHandlerP99Ms: reusedReqToHandlerP99,
      reusedSocketIdleBeforeDataP99Ms: reusedIdleBeforeDataP99,
      reusedSocketDataToReqEventP99Ms: reusedDataToReqEventP99,
    },
  };
}
