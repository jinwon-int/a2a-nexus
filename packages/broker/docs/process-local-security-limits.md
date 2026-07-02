# Process-local security limits

The broker has several protections that are intentionally process-local in the alpha deployment profile.

## HTTP-signature replay cache

`a2a-http-signature-replay-cache.ts` uses an in-process bounded map. It rejects duplicate signatures seen by the same broker process during the configured replay window.

Limits:

- Restarting the broker clears the replay cache.
- Running multiple broker processes gives each process its own cache.
- Horizontal scaling therefore needs a shared replay store before replay protection can be described as cluster-wide.

## In-memory rate limiter

`InMemoryRateLimiter` is also process-local.

Limits:

- A restart resets request counters.
- Multiple broker instances enforce limits independently.
- Load balancers can distribute requests across instances unless they provide sticky routing or a shared limiter is introduced.

## Operator contract

These limits are acceptable for the current single-broker alpha posture, but they are security-relevant and must be revisited before horizontal scaling or HA promotion.

Do not claim cluster-wide replay or rate-limit guarantees until a shared backing store is implemented and tested.
