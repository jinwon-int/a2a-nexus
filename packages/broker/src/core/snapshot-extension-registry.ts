// Snapshot extension registry, extracted from the InMemoryA2ABroker god-class
// (collaborator pattern from #1075-#1077). Holds the optional providers that
// contribute extra fields to full broker snapshots (e.g. server-side state that
// lives outside the broker), and merges their output. BrokerSnapshot is imported
// type-only, so there is no runtime import cycle.
import type { BrokerSnapshot } from "./proof-matrix.js";

export class SnapshotExtensionRegistry {
  private readonly providers = new Set<() => Partial<BrokerSnapshot>>();

  constructor(initial?: () => Partial<BrokerSnapshot>) {
    if (initial) {
      this.providers.add(initial);
    }
  }

  register(provider: () => Partial<BrokerSnapshot>): () => void {
    this.providers.add(provider);
    return () => {
      this.providers.delete(provider);
    };
  }

  collectFields(): Partial<BrokerSnapshot> {
    let extensions: Partial<BrokerSnapshot> = {};
    for (const provider of this.providers) {
      extensions = { ...extensions, ...provider() };
    }
    return extensions;
  }
}
