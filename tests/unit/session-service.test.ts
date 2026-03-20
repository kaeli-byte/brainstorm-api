import { beforeEach, describe, expect, it } from "vitest";
import { sessionService } from "../../src/session/service.js";
import { store } from "../../src/reasoning_graph/store.js";
import { FakeLlmProvider } from "../../src/orchestration/providers.js";
import { loadPromptConfig } from "../../src/orchestration/promptRegistry.js";

describe("SessionService", () => {
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

  it("creates a draft session", () => {
    const session = sessionService.createSession({ problemStatement: "What next?" });
    expect(session.state).toBe("draft");
  });

  it("improves a fuzzy problem statement into the expected five sections", async () => {
    const result = await sessionService.improveProblemStatement("customers keep dropping after signup and we are not sure why");

    expect(result.clarifiedProblemStatement).toContain("customers keep dropping after signup");
    expect(result.contextAndConstraints.length).toBeGreaterThan(0);
    expect(result.successCriteria.length).toBeGreaterThan(0);
    expect(result.scopeBoundaries.length).toBeGreaterThan(0);
    expect(result.brainstormingLaunchQuestion.length).toBeGreaterThan(0);
  });

  it("rejects empty problem statements when improving them", async () => {
    await expect(sessionService.improveProblemStatement("   ")).rejects.toThrow("problem_statement_required");
  });

  it("passes persisted problem framing context into later LLM calls", async () => {
    const session = sessionService.createSession({
      problemStatement: "Reduce onboarding drop-off",
      roles: ["agent_01"],
      context: {
        problemFraming: {
          clarifiedProblemStatement: "Reduce new-user drop-off during onboarding without increasing support load.",
          contextAndConstraints: "Users leave before activation. Team capacity is limited this quarter.",
          successCriteria: "Higher activation, lower abandonment, no support spike.",
          scopeBoundaries: "In scope: onboarding experience. Out of scope: pricing and sales changes.",
          brainstormingLaunchQuestion: "How might we reduce onboarding drop-off within current team capacity?"
        }
      }
    });
    const provider = (sessionService as unknown as { llm: FakeLlmProvider }).llm;
    const originalGenerateIdeas = provider.generateIdeas.bind(provider);
    let receivedFraming: unknown;

    try {
      provider.generateIdeas = async (input) => {
        receivedFraming = input.framingContext;
        return originalGenerateIdeas(input);
      };

      await sessionService.startPhase(session.id, "diverge");

      expect(receivedFraming).toEqual(session.context?.problemFraming);
    } finally {
      provider.generateIdeas = originalGenerateIdeas;
    }
  });

  it("edits persisted problem framing and updates the session problem statement", () => {
    const session = sessionService.createSession({
      problemStatement: "Reduce onboarding drop-off",
      context: {
        problemFraming: {
          clarifiedProblemStatement: "Reduce new-user drop-off during onboarding without increasing support load.",
          contextAndConstraints: "Users leave before activation. Team capacity is limited this quarter.",
          successCriteria: "Higher activation, lower abandonment, no support spike.",
          scopeBoundaries: "In scope: onboarding experience. Out of scope: pricing and sales changes.",
          brainstormingLaunchQuestion: "How might we reduce onboarding drop-off within current team capacity?"
        }
      }
    });

    const details = sessionService.editProblemFraming(session.id, {
      successCriteria: "Higher activation, lower abandonment, and faster time-to-value.",
      clarifiedProblemStatement: "Reduce onboarding drop-off while shortening time-to-value."
    });

    expect(details.session.context?.problemFraming).toMatchObject({
      successCriteria: "Higher activation, lower abandonment, and faster time-to-value.",
      clarifiedProblemStatement: "Reduce onboarding drop-off while shortening time-to-value."
    });
    expect(details.session.problemStatement).toBe("Reduce onboarding drop-off while shortening time-to-value.");
    expect(details.edits.some((item) => item.editType === "problem_framing_update")).toBe(true);
  });

  it("keeps prior diverge outputs on rerun", async () => {
    const session = sessionService.createSession({ problemStatement: "What next?" });
    await sessionService.startPhase(session.id, "diverge");
    const firstOutput = store.getActiveOutputSet(session.id, "diverge");
    await sessionService.rerunPhase(session.id, "diverge");
    const outputs = [...store.outputSets.values()].filter((item) => item.sessionId === session.id && item.phase === "diverge");
    expect(outputs).toHaveLength(2);
    expect(outputs.some((item) => item.id === firstOutput?.id && item.status === "superseded")).toBe(true);
  });

  it("does not replace active output when rerun fails", async () => {
    const session = sessionService.createSession({ problemStatement: "What next?" });
    await sessionService.startPhase(session.id, "diverge");
    const firstOutput = store.getActiveOutputSet(session.id, "diverge");

    const originalProvider = (sessionService as unknown as { llm: FakeLlmProvider }).llm;
    (sessionService as unknown as { llm: { generateIdeas: () => Promise<never> } }).llm = {
      ...(originalProvider as object),
      generateIdeas: async () => {
        throw new Error("provider_timeout");
      }
    };

    await expect(sessionService.rerunPhase(session.id, "diverge")).rejects.toThrow("provider_timeout");
    const stillActive = store.getActiveOutputSet(session.id, "diverge");
    expect(stillActive?.id).toBe(firstOutput?.id);
    expect(store.sessions.get(session.id)?.state).toBe("diverge_failed");

    (sessionService as unknown as { llm: FakeLlmProvider }).llm = originalProvider;
  });

  it("preserves the originating role on diverge ideas", async () => {
    const session = sessionService.createSession({ problemStatement: "What next?" });
    await sessionService.startPhase(session.id, "diverge");

    const activeOutput = store.getActiveOutputSet(session.id, "diverge");
    const ideas = [...store.nodes.values()].filter((item) => item.outputSetId === activeOutput?.id);

    expect(ideas.some((item) => item.sourceRole === "The Reframer" && String(item.content.text).startsWith("The Reframer idea"))).toBe(true);
    expect(ideas.some((item) => item.sourceRole === "The Analogist" && String(item.content.text).startsWith("The Analogist idea"))).toBe(true);
    expect(ideas.some((item) => item.sourceRole === "The Grounder" && String(item.content.text).startsWith("The Grounder idea"))).toBe(true);
  });

  it("derives cluster labels from grouped idea content instead of generic theme names", async () => {
    const session = sessionService.createSession({ problemStatement: "Improve customer support", roles: ["agent_01"] });
    const provider = (sessionService as unknown as { llm: FakeLlmProvider }).llm;
    const originalGenerateIdeas = provider.generateIdeas.bind(provider);
    const originalEmbedTexts = provider.embedTexts.bind(provider);

    try {
      provider.generateIdeas = async () => [
        { text: "Automate ticket triage with AI routing", rationale: "Reduce manual queue sorting" },
        { text: "AI ticket summaries for faster handoffs", rationale: "Speed up support collaboration" },
        { text: "Build a self-serve knowledge base for onboarding", rationale: "Deflect repetitive setup questions" }
      ];
      provider.embedTexts = async () => [
        [20, 0, 0],
        [20, 0, 0],
        [0, 20, 0]
      ];

      await sessionService.startPhase(session.id, "diverge");
      const details = await sessionService.startPhase(session.id, "cluster");
      const labels = details.nodes
        .filter((item) => item.phase === "cluster" && item.nodeType === "cluster")
        .map((item) => String(item.content.label));

      expect(labels).toHaveLength(2);
      expect(labels.some((label) => label.includes("Ticket") || label.includes("Automate"))).toBe(true);
      expect(labels.some((label) => label.includes("Knowledge") || label.includes("Onboarding"))).toBe(true);
      expect(labels.every((label) => !label.startsWith("Theme "))).toBe(true);
    } finally {
      provider.generateIdeas = originalGenerateIdeas;
      provider.embedTexts = originalEmbedTexts;
    }
  });

  it("tracks decision summary edits as revised decision proposal nodes", async () => {
    const session = sessionService.createSession({ problemStatement: "What next?" });
    await sessionService.startPhase(session.id, "diverge");
    await sessionService.startPhase(session.id, "cluster");
    await sessionService.startPhase(session.id, "challenge");
    await sessionService.startPhase(session.id, "decide");

    const beforeEdit = [...store.nodes.values()].find(
      (item) => item.sessionId === session.id && item.nodeType === "decision_proposal" && item.status === "active"
    );
    expect(beforeEdit).toBeDefined();

    const details = sessionService.editDecisionSummary(session.id, {
      recommendation: "Edited recommendation",
      nextSteps: ["Edited next step"]
    });

    const activeProposal = details.nodes.find(
      (item) => item.nodeType === "decision_proposal" && item.phase === "decision" && item.status === "active"
    );
    const supersededProposal = details.nodes.find((item) => item.id === beforeEdit?.id);

    expect(activeProposal?.content.recommendation).toBe("Edited recommendation");
    expect(activeProposal?.derivedFromNodeId).toBe(beforeEdit?.id);
    expect(supersededProposal?.status).toBe("superseded");
    expect(details.edits.some((item) => item.editType === "decision_summary_update")).toBe(true);
  });

  it("retries a transient provider timeout within budget and records the retry count", async () => {
    const session = sessionService.createSession({ problemStatement: "What next?", roles: ["agent_01"] });
    const provider = (sessionService as unknown as { llm: FakeLlmProvider }).llm;
    const originalGenerateIdeas = provider.generateIdeas.bind(provider);
    let calls = 0;

    provider.generateIdeas = async (input) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("provider_timeout");
      }
      return originalGenerateIdeas(input);
    };

    const details = await sessionService.startPhase(session.id, "diverge");
    const run = details.phaseRuns.find((item) => item.phase === "diverge");

    expect(run?.status).toBe("completed");
    expect(run?.retryCount).toBe(1);
    expect(calls).toBe(2);

    provider.generateIdeas = originalGenerateIdeas;
  });

  it("preserves failed run diagnostics after retry budget exhaustion", async () => {
    const session = sessionService.createSession({ problemStatement: "What next?" });
    const provider = (sessionService as unknown as { llm: FakeLlmProvider }).llm;
    const originalGenerateIdeas = provider.generateIdeas.bind(provider);

    provider.generateIdeas = async ({ role, roleId }) => {
      if (role === "The Analogist") {
        throw new Error("provider_timeout");
      }
      const promptConfig = loadPromptConfig("diverge");
      return originalGenerateIdeas({
        problemStatement: "What next?",
        role,
        roleId,
        promptConfig,
        roleDefinition: promptConfig.roleDefinitions[roleId]
      });
    };

    await expect(sessionService.startPhase(session.id, "diverge")).rejects.toThrow("provider_timeout");
    const run = [...store.phaseRuns.values()].find((item) => item.sessionId === session.id && item.phase === "diverge");

    expect(run?.status).toBe("failed");
    expect(run?.errorCategory).toBe("provider_timeout");
    expect(run?.retryCount).toBe(1);
    expect(run?.diagnostics?.partialOutputs).toEqual([{ role: "The Reframer", ideaCount: 12 }]);

    provider.generateIdeas = originalGenerateIdeas;
  });

  it("rejects stale writes when editing a superseded idea node", async () => {
    const session = sessionService.createSession({ problemStatement: "What next?", roles: ["agent_01"] });
    await sessionService.startPhase(session.id, "diverge");
    const activeOutput = store.getActiveOutputSet(session.id, "diverge");
    const idea = [...store.nodes.values()].find((item) => item.outputSetId === activeOutput?.id && item.nodeType === "idea");

    expect(idea).toBeDefined();
    sessionService.editIdea(session.id, idea!.id, "First revision");
    await expect(() => sessionService.editIdea(session.id, idea!.id, "Second revision")).toThrow("stale_write");
  });

  it("keeps the session approved and records a failed export for retry", async () => {
    const session = sessionService.createSession({ problemStatement: "What next?" });
    await sessionService.startPhase(session.id, "diverge");
    await sessionService.startPhase(session.id, "cluster");
    await sessionService.startPhase(session.id, "challenge");
    await sessionService.startPhase(session.id, "decide");
    sessionService.editDecisionSummary(session.id, { recommendation: "[[EXPORT_FAIL]]" });
    sessionService.approveDecision(session.id);

    expect(() => sessionService.exportSession(session.id, "markdown")).toThrow("export_render_failed");
    expect(store.sessions.get(session.id)?.state).toBe("approved");
    expect([...store.exports.values()].some((item) => item.sessionId === session.id && item.status === "failed")).toBe(true);

    sessionService.exportSession(session.id, "pdf");
    expect(store.sessions.get(session.id)?.state).toBe("exported");
  });
});
