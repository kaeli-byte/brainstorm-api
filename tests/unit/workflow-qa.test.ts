import { beforeEach, describe, expect, it } from "vitest";
import { sessionService } from "../../src/session/service.js";
import { store } from "../../src/reasoning_graph/store.js";
import { FakeLlmProvider } from "../../src/orchestration/providers.js";
import { loadPromptConfig } from "../../src/orchestration/promptRegistry.js";

describe("workflow QA coverage", () => {
  beforeEach(() => {
    store.sessions.clear();
    store.phaseRuns.clear();
    store.outputSets.clear();
    store.nodes.clear();
    store.edges.clear();
    store.exports.clear();
    store.edits.clear();
    process.env.USE_FAKE_LLM = "true";
  });

  it("covers the happy path from session creation through export", async () => {
    const session = sessionService.createSession({ problemStatement: "How should we grow?" });

    await sessionService.startPhase(session.id, "diverge");
    await sessionService.startPhase(session.id, "cluster");
    await sessionService.startPhase(session.id, "challenge");
    await sessionService.startPhase(session.id, "decide");

    const approved = sessionService.approveDecision(session.id);
    expect(approved.session.state).toBe("approved");
    const exported = sessionService.exportSession(session.id, "markdown");

    expect(exported.status).toBe("completed");
    expect(store.sessions.get(session.id)?.state).toBe("exported");
  });

  it("covers the rerun path by superseding prior diverge outputs", async () => {
    const session = sessionService.createSession({ problemStatement: "How should we grow?" });

    await sessionService.startPhase(session.id, "diverge");
    const firstOutput = store.getActiveOutputSet(session.id, "diverge");
    const rerun = await sessionService.rerunPhase(session.id, "diverge");
    const activeOutput = store.getActiveOutputSet(session.id, "diverge");

    expect(rerun.session.state).toBe("diverge_review");
    expect(activeOutput?.id).not.toBe(firstOutput?.id);
    expect(firstOutput && store.outputSets.get(firstOutput.id)?.status).toBe("superseded");
  });

  it("covers the edit-then-rerun path after an upstream idea change", async () => {
    const session = sessionService.createSession({ problemStatement: "How should we grow?", roles: ["agent_01"] });

    await sessionService.startPhase(session.id, "diverge");
    await sessionService.startPhase(session.id, "cluster");
    await sessionService.startPhase(session.id, "challenge");
    await sessionService.startPhase(session.id, "decide");

    const idea = [...store.nodes.values()].find(
      (item) => item.sessionId === session.id && item.phase === "diverge" && item.nodeType === "idea" && item.status === "active"
    );
    expect(idea).toBeDefined();

    const edited = sessionService.editIdea(session.id, idea!.id, "Reframed growth idea");
    expect(edited.session.state).toBe("diverge_review");
    expect(() => sessionService.approveDecision(session.id)).toThrow("Decision not ready");

    await sessionService.startPhase(session.id, "cluster");
    await sessionService.startPhase(session.id, "challenge");
    await sessionService.startPhase(session.id, "decide");

    const approved = sessionService.approveDecision(session.id);
    expect(approved.session.state).toBe("approved");
  });

  it("covers the reject-decision path back to challenge review", async () => {
    const session = sessionService.createSession({ problemStatement: "How should we grow?" });

    await sessionService.startPhase(session.id, "diverge");
    await sessionService.startPhase(session.id, "cluster");
    await sessionService.startPhase(session.id, "challenge");
    await sessionService.startPhase(session.id, "decide");

    const rejected = sessionService.rejectDecision(session.id, "challenge_review");
    expect(rejected.session.state).toBe("challenge_review");

    await sessionService.startPhase(session.id, "decide");
    const approved = sessionService.approveDecision(session.id);
    expect(approved.session.state).toBe("approved");
  });

  it("covers retry success and exhausted retry failure paths", async () => {
    const retrySession = sessionService.createSession({ problemStatement: "How should we grow?", roles: ["agent_01"] });
    const provider = (sessionService as unknown as { llm: FakeLlmProvider }).llm;
    const originalGenerateIdeas = provider.generateIdeas.bind(provider);
    let retryCalls = 0;

    provider.generateIdeas = async (input) => {
      retryCalls += 1;
      if (retryCalls === 1) {
        throw new Error("provider_timeout");
      }
      return originalGenerateIdeas(input);
    };

    const retried = await sessionService.startPhase(retrySession.id, "diverge");
    const retriedRun = retried.phaseRuns.find((item) => item.phase === "diverge");

    expect(retriedRun?.status).toBe("completed");
    expect(retriedRun?.retryCount).toBe(1);

    provider.generateIdeas = async ({ role, roleId }) => {
      if (role === "The Analogist") {
        throw new Error("provider_timeout");
      }
      const promptConfig = loadPromptConfig("diverge");
      return originalGenerateIdeas({
        problemStatement: "How should we grow?",
        role,
        roleId,
        promptConfig,
        roleDefinition: promptConfig.roleDefinitions[roleId]
      });
    };

    const failedSession = sessionService.createSession({ problemStatement: "How should we grow?" });
    await expect(sessionService.startPhase(failedSession.id, "diverge")).rejects.toThrow("provider_timeout");

    const failedRun = [...store.phaseRuns.values()].find(
      (item) => item.sessionId === failedSession.id && item.phase === "diverge"
    );
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.retryCount).toBe(1);
    expect(failedRun?.diagnostics?.partialOutputs).toEqual([{ role: "The Reframer", ideaCount: 12 }]);

    provider.generateIdeas = originalGenerateIdeas;
  });
});
