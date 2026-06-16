import type { IncomingMessage, ServerResponse } from "node:http";

export function parseSseReplayAfterId(rawLastEventId: string | undefined, fallback = -1): number {
  if (!rawLastEventId) return fallback;
  const parsed = Number(rawLastEventId);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function attachSseConnectionCleanup(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  cleanup: () => void,
  options: { endResponseOnClose?: boolean } = {},
): void {
  const endResponseOnClose = options.endResponseOnClose ?? true;
  req.on("close", () => {
    cleanup();
    if (endResponseOnClose && !res.writableEnded) {
      res.end();
    }
  });
  req.on("error", cleanup);
}

export function startSseHeartbeat(
  res: ServerResponse<IncomingMessage>,
  heartbeatMs: number,
  cleanup: () => void,
): () => void {
  if (heartbeatMs <= 0) {
    return noop;
  }

  let timer: NodeJS.Timeout | null = setInterval(() => {
    if (res.writableEnded) {
      cleanup();
      return;
    }
    res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, heartbeatMs);
  timer.unref?.();

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function noop(): void {
  // Intentionally empty.
}
