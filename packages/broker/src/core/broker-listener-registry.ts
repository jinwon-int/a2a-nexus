// Broker state-change and profiling listener registry, extracted from the
// InMemoryA2ABroker god-class (collaborator pattern validated in
// task-event-dispatcher.ts). Owns the state-change and profiling listener sets
// plus the option-provided profiling listener, and handles subscribe + notify.
//
// The listener/change/sample types are defined and exported by broker.ts; they
// are imported here type-only, so there is no runtime import cycle.
import type {
  BrokerProfilingListener,
  BrokerProfilingSample,
  BrokerStateChange,
  BrokerStateListener,
} from "./broker.js";

export class BrokerListenerRegistry {
  private readonly stateListeners = new Set<BrokerStateListener>();
  private readonly profilingListeners = new Set<BrokerProfilingListener>();

  constructor(private readonly optionProfilingListener?: BrokerProfilingListener) {}

  subscribeState(listener: BrokerStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  subscribeProfiling(listener: BrokerProfilingListener): () => void {
    this.profilingListeners.add(listener);
    return () => {
      this.profilingListeners.delete(listener);
    };
  }

  emitStateChange(change: BrokerStateChange): void {
    for (const listener of [...this.stateListeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error(
          `[a2a-broker] broker state listener threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  emitProfilingSample(sample: BrokerProfilingSample): void {
    const listeners = this.optionProfilingListener
      ? [this.optionProfilingListener, ...this.profilingListeners]
      : [...this.profilingListeners];
    for (const listener of listeners) {
      try {
        listener({ ...sample, saveHints: sample.saveHints ? { ...sample.saveHints } : undefined });
      } catch (error) {
        console.error(
          `[a2a-broker] broker profiling listener threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
