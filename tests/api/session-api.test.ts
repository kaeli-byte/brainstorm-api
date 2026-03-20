import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server.js";
import { store } from "../../src/reasoning_graph/store.js";
import { createStorePersistence, type StorePersistence } from "../../src/reasoning_graph/persistence.js";
import type { FastifyInstance } from "fastify";
import { SessionService } from "../../src/session/service.js";
import { FakeLlmProvider } from "../../src/orchestration/providers.js";

describe("Session API workflow", () => {
  let app: FastifyInstance;
  let persistence: StorePersistence;
  let runtimeSessionService: SessionService;
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    USE_FAKE_LLM: process.env.USE_FAKE_LLM,
    VITEST: process.env.VITEST
  };

  beforeEach(async () => {
    store.sessions.clear();
    store.phaseRuns.clear();
    store.outputSets.clear();
    store.nodes.clear();
    store.edges.clear();
    store.exports.clear();
    store.edits.clear();
    process.env.USE_FAKE_LLM = "true";
    persistence = createStorePersistence();
    if (persistence.isEnabled()) {
      await persistence.initialize();
      await persistence.reset();
    } else {
      persistence.getStore().clear();
    }
    runtimeSessionService = new SessionService(persistence.getStore());
    app = await buildApp({ persistence, sessionService: runtimeSessionService });
  });

  afterEach(async () => {
    await app.close();
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    process.env.GEMINI_API_KEY = originalEnv.GEMINI_API_KEY;
    process.env.USE_FAKE_LLM = originalEnv.USE_FAKE_LLM;
    process.env.VITEST = originalEnv.VITEST;
  });

  it("fails app boot in production without a database url", async () => {
    await app.close();
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    process.env.GEMINI_API_KEY = "test-key";
    process.env.USE_FAKE_LLM = "false";
    process.env.VITEST = "false";

    await expect(buildApp({ persistence, sessionService: runtimeSessionService })).rejects.toThrowError(
      "DATABASE_URL is required in production"
    );
  });

  it("fails app boot outside tests when fake llm is enabled", async () => {
    await app.close();
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;
    delete process.env.GEMINI_API_KEY;
    process.env.USE_FAKE_LLM = "true";
    process.env.VITEST = "false";

    await expect(buildApp({ persistence, sessionService: runtimeSessionService })).rejects.toThrowError(
      "USE_FAKE_LLM=true is not allowed outside tests"
    );
  });

  it("fails app boot outside tests when gemini credentials are missing", async () => {
    await app.close();
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;
    delete process.env.GEMINI_API_KEY;
    process.env.USE_FAKE_LLM = "false";
    process.env.VITEST = "false";

    await expect(buildApp({ persistence, sessionService: runtimeSessionService })).rejects.toThrowError(
      "GEMINI_API_KEY is required when USE_FAKE_LLM=false"
    );
  });

  it("runs happy path from session creation to export", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?", roles: ["agent_01"] })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/cluster/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/challenge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/decide/start`).send({}).expect(200);
    const approved = await request(app.server).post(`/api/sessions/${id}/decision/approve`).send({}).expect(200);
    expect(approved.body.session.state).toBe("approved");

    const exported = await request(app.server).post(`/api/sessions/${id}/exports`).send({ format: "markdown" }).expect(200);
    expect(exported.body.status).toBe("completed");
  });

  it("rejects illegal phase order", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?", roles: ["agent_01"] })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/cluster/start`).send({}).expect(400);
  });

  it("validates session creation input", async () => {
    await app.ready();
    const response = await request(app.server).post("/api/sessions").send({ problemStatement: "" }).expect(400);
    expect(response.body.error).toBe("validation_error");
  });

  it("improves a rough problem statement before session creation", async () => {
    await app.ready();
    const response = await request(app.server)
      .post("/api/problem-statement/improve")
      .send({ problemStatement: "our onboarding is confusing and users leave early" })
      .expect(200);

    expect(response.body.clarifiedProblemStatement).toContain("our onboarding is confusing");
    expect(response.body.contextAndConstraints).toBeTruthy();
    expect(response.body.successCriteria).toBeTruthy();
    expect(response.body.scopeBoundaries).toBeTruthy();
    expect(response.body.brainstormingLaunchQuestion).toBeTruthy();
  });

  it("updates a tool prompt through admin publish and uses it on the next improve request without restart", async () => {
    await app.ready();

    const registry = await request(app.server).get("/api/admin/prompts").expect(200);
    expect(registry.body.tool_prompt.some((item: { name: string }) => item.name === "improve-statement")).toBe(true);

    const details = await request(app.server).get("/api/admin/prompts/tool_prompt/improve-statement").expect(200);
    const nextContent = `${details.body.draft.content}\n\nKeep every field under 10 words.`;

    await request(app.server)
      .patch("/api/admin/prompts/tool_prompt/improve-statement/draft")
      .send({ content: nextContent })
      .expect(200);

    await request(app.server)
      .post("/api/admin/prompts/tool_prompt/improve-statement/publish")
      .send({ notes: "tighten improve prompt" })
      .expect(200);

    const improved = await request(app.server)
      .post("/api/problem-statement/improve")
      .send({ problemStatement: "our onboarding is confusing and users leave early" })
      .expect(200);

    expect(typeof improved.body.clarifiedProblemStatement).toBe("string");
    expect(improved.body.clarifiedProblemStatement.length).toBeGreaterThan(0);
  });

  it("persists problem framing context on the session record", async () => {
    await app.ready();
    const framing = {
      clarifiedProblemStatement: "Reduce onboarding drop-off without adding manual support work.",
      contextAndConstraints: "New users abandon setup early. Team capacity is limited this quarter.",
      successCriteria: "Higher activation and no support spike.",
      scopeBoundaries: "In scope: onboarding flow. Out of scope: pricing changes.",
      brainstormingLaunchQuestion: "How might we reduce onboarding drop-off within current team capacity?"
    };

    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: framing.clarifiedProblemStatement, context: { problemFraming: framing } })
      .expect(201);

    const session = await request(app.server).get(`/api/sessions/${created.body.id as string}`).expect(200);
    expect(session.body.session.context.problemFraming).toEqual(framing);
  });

  it("updates an individual problem framing field through the session API", async () => {
    await app.ready();
    const framing = {
      clarifiedProblemStatement: "Reduce onboarding drop-off without adding manual support work.",
      contextAndConstraints: "New users abandon setup early. Team capacity is limited this quarter.",
      successCriteria: "Higher activation and no support spike.",
      scopeBoundaries: "In scope: onboarding flow. Out of scope: pricing changes.",
      brainstormingLaunchQuestion: "How might we reduce onboarding drop-off within current team capacity?"
    };

    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: framing.clarifiedProblemStatement, context: { problemFraming: framing } })
      .expect(201);

    const updated = await request(app.server)
      .patch(`/api/sessions/${created.body.id as string}/problem-framing`)
      .send({ successCriteria: "Higher activation, lower abandonment, and no support spike." })
      .expect(200);

    expect(updated.body.session.context.problemFraming.successCriteria).toBe(
      "Higher activation, lower abandonment, and no support spike."
    );
  });

  it("returns 404 for unknown sessions", async () => {
    await app.ready();
    await request(app.server).get("/api/sessions/session_missing").expect(404);
  });

  it("reports health and readiness", async () => {
    await app.ready();

    const health = await request(app.server).get("/health").expect(200);
    expect(health.body.status).toBe("ok");

    const readiness = await request(app.server).get("/ready").expect(200);
    expect(readiness.body.status).toBe("ready");
  });

  it("marks downstream output stale after edit", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?", roles: ["agent_01"] })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/cluster/start`).send({}).expect(200);

    const session = await request(app.server).get(`/api/sessions/${id}`).expect(200);
    const idea = session.body.nodes.find((node: { nodeType: string }) => node.nodeType === "idea");
    await request(app.server).patch(`/api/sessions/${id}/ideas/${idea.id}`).send({ text: "Edited idea" }).expect(200);
    const refreshed = await request(app.server).get(`/api/sessions/${id}`).expect(200);
    expect(refreshed.body.outputSets.some((item: { phase: string; status: string }) => item.phase === "cluster" && item.status === "stale")).toBe(true);
  });

  it("persists idea titles produced during diverge", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?", roles: ["agent_01"] })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);

    const session = await request(app.server).get(`/api/sessions/${id}`).expect(200);
    const idea = session.body.nodes.find(
      (node: { nodeType: string; phase: string; status: string; content: Record<string, unknown> }) =>
        node.nodeType === "idea" && node.phase === "diverge" && node.status === "active"
    );

    expect(typeof idea?.content.title).toBe("string");
    expect(String(idea?.content.title)).not.toHaveLength(0);
  });

  it("blocks approval after an upstream edit makes decision inputs stale", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?" })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/cluster/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/challenge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/decide/start`).send({}).expect(200);

    const session = await request(app.server).get(`/api/sessions/${id}`).expect(200);
    const cluster = session.body.nodes.find((node: { nodeType: string; phase: string; status: string }) => node.nodeType === "cluster" && node.phase === "cluster" && node.status === "active");
    await request(app.server).patch(`/api/sessions/${id}/clusters/${cluster.id}`).send({ label: "Edited cluster" }).expect(200);

    await request(app.server).post(`/api/sessions/${id}/decision/approve`).send({}).expect(400);
    const refreshed = await request(app.server).get(`/api/sessions/${id}`).expect(200);
    expect(refreshed.body.session.state).toBe("cluster_review");
  });

  it("allows editing the decision summary before approval", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?" })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/cluster/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/challenge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/decide/start`).send({}).expect(200);

    const edited = await request(app.server)
      .patch(`/api/sessions/${id}/decision-summary`)
      .send({
        recommendation: "Edited recommendation",
        rationale: "Edited rationale",
        risks: ["Edited risk"],
        nextSteps: ["Edited next step"]
      })
      .expect(200);

    const proposal = edited.body.nodes.find(
      (node: { nodeType: string; phase: string; status: string }) =>
        node.nodeType === "decision_proposal" && node.phase === "decision" && node.status === "active"
    );
    expect(proposal.content.recommendation).toBe("Edited recommendation");
    expect(proposal.content.rationale).toBe("Edited rationale");

    const approved = await request(app.server).post(`/api/sessions/${id}/decision/approve`).send({}).expect(200);
    const snapshot = approved.body.nodes.find(
      (node: { nodeType: string; phase: string; status: string }) =>
        node.nodeType === "decision_snapshot" && node.phase === "decision" && node.status === "active"
    );
    expect(snapshot.content.recommendation).toBe("Edited recommendation");
    expect(snapshot.content.nextSteps).toEqual(["Edited next step"]);
  });

  it("forces rerun after an upstream idea edit instead of allowing phase skipping", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?", roles: ["agent_01"] })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/cluster/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/challenge/start`).send({}).expect(200);

    const session = await request(app.server).get(`/api/sessions/${id}`).expect(200);
    const idea = session.body.nodes.find(
      (node: { nodeType: string; phase: string; status: string }) =>
        node.nodeType === "idea" && node.phase === "diverge" && node.status === "active"
    );

    const edited = await request(app.server).patch(`/api/sessions/${id}/ideas/${idea.id}`).send({ text: "Reframed idea" }).expect(200);
    expect(edited.body.session.state).toBe("diverge_review");

    await request(app.server).post(`/api/sessions/${id}/phases/challenge/start`).send({}).expect(400);
    await request(app.server).post(`/api/sessions/${id}/phases/decide/start`).send({}).expect(400);
    await request(app.server).post(`/api/sessions/${id}/phases/cluster/start`).send({}).expect(200);
  });

  it("rejects stale concurrent idea edits instead of merging them", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?", roles: ["agent_01"] })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);

    const session = await request(app.server).get(`/api/sessions/${id}`).expect(200);
    const idea = session.body.nodes.find(
      (node: { nodeType: string; phase: string; status: string }) =>
        node.nodeType === "idea" && node.phase === "diverge" && node.status === "active"
    );

    await request(app.server).patch(`/api/sessions/${id}/ideas/${idea.id}`).send({ text: "First revision" }).expect(200);
    const staleWrite = await request(app.server)
      .patch(`/api/sessions/${id}/ideas/${idea.id}`)
      .send({ text: "Second revision" })
      .expect(400);

    expect(staleWrite.body.error).toBe("stale_write");
  });

  it("blocks export before approval", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?" })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/exports`).send({ format: "markdown" }).expect(400);
  });

  it("rejects unsupported export format", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?" })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/cluster/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/challenge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/decide/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/decision/approve`).send({}).expect(200);

    const response = await request(app.server).post(`/api/sessions/${id}/exports`).send({ format: "docx" }).expect(400);
    expect(response.body.error).toBe("validation_error");
  });

  it("rejects invalid decision reject targets", async () => {
    await app.ready();
    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?" })
      .expect(201);
    const id = created.body.id as string;

    const response = await request(app.server)
      .post(`/api/sessions/${id}/decision/reject`)
      .send({ returnTarget: "approved" })
      .expect(400);
    expect(response.body.error).toBe("validation_error");
  });

  it("merges active clusters and invalidates downstream outputs", async () => {
    await app.ready();
    const provider = (runtimeSessionService as unknown as { llm: FakeLlmProvider }).llm;
    const originalEmbedTexts = provider.embedTexts.bind(provider);
    provider.embedTexts = async (texts: string[]) =>
      texts.map((_, index) => (index < 4 ? [1000, 0, 0] : [0, 1000, 0]));

    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?" })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/cluster/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/challenge/start`).send({}).expect(200);

    const session = await request(app.server).get(`/api/sessions/${id}`).expect(200);
    const clusters = session.body.nodes.filter((node: { nodeType: string; phase: string; status: string }) => node.nodeType === "cluster" && node.phase === "cluster" && node.status === "active");
    expect(clusters.length).toBeGreaterThanOrEqual(2);

    const merged = await request(app.server)
      .post(`/api/sessions/${id}/clusters/merge`)
      .send({ clusterIds: [clusters[0].id, clusters[1].id], label: "Merged theme" })
      .expect(200);

    const mergedClusters = merged.body.nodes.filter((node: { nodeType: string; phase: string; status: string; content: { label?: string } }) => node.nodeType === "cluster" && node.phase === "cluster" && node.status === "active");
    expect(merged.body.session.state).toBe("cluster_review");
    expect(mergedClusters.some((node: { content: { label?: string } }) => node.content.label === "Merged theme")).toBe(true);
    expect(merged.body.outputSets.some((item: { phase: string; status: string }) => item.phase === "challenge" && item.status === "stale")).toBe(true);

    provider.embedTexts = originalEmbedTexts;
  });

  it("splits an active cluster into multiple active clusters", async () => {
    await app.ready();
    const provider = (runtimeSessionService as unknown as { llm: FakeLlmProvider }).llm;
    const originalEmbedTexts = provider.embedTexts.bind(provider);
    provider.embedTexts = async (texts: string[]) => texts.map((_, index) => (index < 6 ? [1000, 0, 0] : [0, 1000, 0]));

    const created = await request(app.server)
      .post("/api/sessions")
      .send({ problemStatement: "How should we grow?", roles: ["agent_01"] })
      .expect(201);
    const id = created.body.id as string;

    await request(app.server).post(`/api/sessions/${id}/phases/diverge/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/cluster/start`).send({}).expect(200);
    await request(app.server).post(`/api/sessions/${id}/phases/challenge/start`).send({}).expect(200);

    const session = await request(app.server).get(`/api/sessions/${id}`).expect(200);
    const cluster = session.body.nodes.find((node: { nodeType: string; phase: string; status: string }) => node.nodeType === "cluster" && node.phase === "cluster" && node.status === "active");
    const clusterIdeaIds = Array.isArray(cluster.content.ideaIds) ? cluster.content.ideaIds.map(String) : [];
    const midpoint = Math.floor(clusterIdeaIds.length / 2);

    const split = await request(app.server)
      .post(`/api/sessions/${id}/clusters/${cluster.id}/split`)
      .send({
        splits: [
          { label: "Split A", ideaIds: clusterIdeaIds.slice(0, midpoint) },
          { label: "Split B", ideaIds: clusterIdeaIds.slice(midpoint) }
        ]
      })
      .expect(200);

    const activeClusters = split.body.nodes.filter((node: { nodeType: string; phase: string; status: string; content: { label?: string } }) => node.nodeType === "cluster" && node.phase === "cluster" && node.status === "active");
    expect(split.body.session.state).toBe("cluster_review");
    expect(activeClusters.some((node: { content: { label?: string } }) => node.content.label === "Split A")).toBe(true);
    expect(activeClusters.some((node: { content: { label?: string } }) => node.content.label === "Split B")).toBe(true);
    expect(split.body.outputSets.some((item: { phase: string; status: string }) => item.phase === "challenge" && item.status === "stale")).toBe(true);

    provider.embedTexts = originalEmbedTexts;
  });
});
