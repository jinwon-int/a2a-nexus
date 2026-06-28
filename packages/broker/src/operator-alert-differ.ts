// Operator alert differ, extracted from createBrokerServer in server.ts. Tracks
// the set of currently-open operator alerts (by id) and, on each fresh alert
// scan, computes which alerts newly opened and which resolved so the server can
// emit operator-alert-opened / operator-alert-resolved SSE events. Holds only
// the open-alert map; emitting the events stays with the server's event stream.
import type { Alert } from "./core/alert-projection.js";

export class OperatorAlertDiffer {
  private alertsById: Map<string, Alert>;

  constructor(initial: Alert[]) {
    this.alertsById = new Map(initial.map((alert) => [alert.id, alert] as const));
  }

  /**
   * Diff a fresh alert scan against the tracked open set, adopt it as the new
   * open set, and return the newly-opened and newly-resolved alerts (each sorted
   * by id for stable event ordering).
   */
  apply(alerts: Alert[]): { opened: Alert[]; resolved: Alert[] } {
    const nextAlertsById = new Map(alerts.map((alert) => [alert.id, alert] as const));
    const opened = alerts
      .filter((alert) => !this.alertsById.has(alert.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const resolved = [...this.alertsById.values()]
      .filter((alert) => !nextAlertsById.has(alert.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    this.alertsById = nextAlertsById;
    return { opened, resolved };
  }
}
