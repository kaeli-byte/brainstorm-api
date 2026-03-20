import { beforeEach, describe, expect, it } from "vitest";
import { sessionService } from "../../src/session/service.js";
import { store } from "../../src/reasoning_graph/store.js";
import { telemetry } from "../../src/observability/telemetry.js";

describe("telemetry", () => {
  beforeEach(() => {
    store.sessions.clear();
    store.phaseRuns.clear();
    store.outputSets.clear();
    store.nodes.clear();
    store.edges.clear();
    store.exports.clear();
    store.edits.clear();
    telemetry.reset();
    process.env.USE_FAKE_LLM = "true";
  });

  it("records audit events and metrics for the session lifecycle", async () => {
    const session = sessionService.createSession({ problemStatement: "What next?" });

    await sessionService.startPhase(session.id, "diverge");
    await sessionService.startPhase(session.id, "cluster");
    await sessionService.startPhase(session.id, "challenge");
    await sessionService.startPhase(session.id, "decide");
    sessionService.approveDecision(session.id);
    sessionService.exportSession(session.id, "markdown");

    expect(telemetry.auditEvents.some((event) => event.eventType === "SessionCreated")).toBe(true);
    expect(telemetry.auditEvents.some((event) => event.eventType === "PhaseRunStarted" && event.phase === "diverge")).toBe(true);
    expect(telemetry.auditEvents.some((event) => event.eventType === "PhaseRunCompleted" && event.phase === "decide")).toBe(true);
    expect(telemetry.auditEvents.some((event) => event.eventType === "DecisionApproved")).toBe(true);
    expect(telemetry.auditEvents.some((event) => event.eventType === "ExportCompleted")).toBe(true);

    expect(telemetry.metrics.some((metric) => metric.name === "phase_run_total" && metric.tags.phase === "diverge")).toBe(true);
    expect(telemetry.metrics.some((metric) => metric.name === "phase_run_duration_seconds" && metric.tags.phase === "challenge")).toBe(true);
    expect(telemetry.metrics.some((metric) => metric.name === "export_total" && metric.tags.status === "success")).toBe(true);
    expect(telemetry.metrics.some((metric) => metric.name === "session_completion_total" && metric.tags.final_state === "exported")).toBe(true);
  });

  it("records stale output invalidation and decision rejection telemetry", async () => {
    const session = sessionService.createSession({ problemStatement: "What next?" });

    await sessionService.startPhase(session.id, "diverge");
    await sessionService.startPhase(session.id, "cluster");
    await sessionService.startPhase(session.id, "challenge");
    await sessionService.startPhase(session.id, "decide");

    const cluster = [...store.nodes.values()].find(
      (item) => item.sessionId === session.id && item.phase === "cluster" && item.nodeType === "cluster" && item.status === "active"
    );
    expect(cluster).toBeDefined();

    sessionService.editCluster(session.id, cluster!.id, "Retitled cluster");
    await sessionService.startPhase(session.id, "challenge");
    await sessionService.startPhase(session.id, "decide");
    sessionService.rejectDecision(session.id, "challenge_review");

    expect(telemetry.auditEvents.some((event) => event.eventType === "PhaseOutputsMarkedStale")).toBe(true);
    expect(telemetry.auditEvents.some((event) => event.eventType === "DecisionRejected")).toBe(true);
    expect(telemetry.metrics.some((metric) => metric.name === "stale_output_set_total")).toBe(true);
    expect(
      telemetry.metrics.some(
        (metric) => metric.name === "decision_rejection_total" && metric.tags.return_target === "challenge_review"
      )
    ).toBe(true);
  });
});
