import { describe, expect, it } from "vitest";
import { loadPromptConfig } from "../../src/orchestration/promptRegistry.js";
import { sessionService } from "../../src/session/service.js";
import { store } from "../../src/reasoning_graph/store.js";

describe("prompt registry", () => {
  it("loads repo-backed template, schema, and role definitions for a phase", () => {
    const config = loadPromptConfig("diverge");

    expect(config.templateVersion).toBe("diverge-v1");
    expect(config.roleConfigVersion).toBe("roles-v1");
    expect(config.schemaVersion).toBe("ideas-v1");
    expect(config.template).toContain("Generate 12 to 15 concise ideas per assigned role");
    expect(config.schema.type).toBe("array");
    expect(config.roles).toEqual(["agent_01", "agent_02", "agent_03"]);
    expect(config.roleDefinitions.agent_01.systemPrompt).toContain("transforming the structure of the problem itself");
    expect(config.roleDefinitions.agent_01.name).toBe("The Reframer");
    expect(config.roleDefinitions.agent_02.version).toBe("roles-v1");
  });

  it("persists manifest-derived version metadata onto phase runs", async () => {
    store.sessions.clear();
    store.phaseRuns.clear();
    store.outputSets.clear();
    store.nodes.clear();
    store.edges.clear();
    store.exports.clear();
    store.edits.clear();
    process.env.USE_FAKE_LLM = "true";
    process.env.GEMINI_MODEL = "gemini-2.5-flash";

    const session = sessionService.createSession({ problemStatement: "What next?" });
    const details = await sessionService.startPhase(session.id, "diverge");
    const run = details.phaseRuns.find((item) => item.phase === "diverge");

    expect(run?.promptTemplateVersion).toBe("diverge-v1");
    expect(run?.roleConfigVersion).toBe("roles-v1");
    expect(run?.schemaVersion).toBe("ideas-v1");
    expect(run?.model).toBe("gemini-2.5-flash");
  });

  it("uses the diverge prompt contract for idea count in the fake provider path", async () => {
    store.sessions.clear();
    store.phaseRuns.clear();
    store.outputSets.clear();
    store.nodes.clear();
    store.edges.clear();
    store.exports.clear();
    store.edits.clear();
    process.env.USE_FAKE_LLM = "true";

    const session = sessionService.createSession({ problemStatement: "What next?" });
    const details = await sessionService.startPhase(session.id, "diverge");
    const ideaNodes = details.nodes.filter((item) => item.nodeType === "idea" && item.phase === "diverge");

    expect(ideaNodes).toHaveLength(36);
    expect(ideaNodes.every((item) => typeof item.content.title === "string" && String(item.content.title).length > 0)).toBe(true);
  });
});
