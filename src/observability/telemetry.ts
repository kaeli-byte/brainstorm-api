import { nowIso } from "../../shared/utils.js";

export interface MetricRecord {
  name: string;
  value: number;
  tags: Record<string, string>;
  recordedAt: string;
}

export interface AuditEventRecord {
  id: string;
  eventType:
    | "SessionCreated"
    | "PhaseRunStarted"
    | "PhaseRunCompleted"
    | "PhaseRunFailed"
    | "PhaseOutputsMarkedStale"
    | "DecisionRejected"
    | "DecisionApproved"
    | "ExportRequested"
    | "ExportCompleted"
    | "ExportFailed";
  sessionId: string;
  phase?: string;
  runId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class TelemetryStore {
  metrics: MetricRecord[] = [];
  auditEvents: AuditEventRecord[] = [];

  reset() {
    this.metrics = [];
    this.auditEvents = [];
  }

  increment(name: string, tags: Record<string, string>, value = 1) {
    this.metrics.push({
      name,
      value,
      tags,
      recordedAt: nowIso()
    });
  }

  timing(name: string, value: number, tags: Record<string, string>) {
    this.metrics.push({
      name,
      value,
      tags,
      recordedAt: nowIso()
    });
  }

  audit(event: AuditEventRecord) {
    this.auditEvents.push(event);
  }
}

export const telemetry = new TelemetryStore();
