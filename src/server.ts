import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import path from "node:path";
import { existsSync } from "node:fs";
import { getBrainstormApiRoot } from "./packageRoot.js";
import fastifyStatic from "@fastify/static";
import { ZodError, z } from "zod";
import { SessionService, sessionService } from "./session/service.js";
import { phases, type PromptSetType } from "../shared/types.js";
import { initializeReasoningGraphStore } from "./reasoning_graph/init.js";
import { createStorePersistence, type StorePersistence } from "./reasoning_graph/persistence.js";
import { readRuntimeConfig, validateRuntimeConfig } from "./runtime/config.js";
import {
  getPromptSetDetails,
  initializePromptRegistryStore,
  listPromptSets,
  publishPromptSet,
  restorePromptVersion,
  updatePromptDraft,
  validatePromptSet
} from "./orchestration/promptRegistryRepository.js";
import * as openApi from "./openapi-schemas.js";
import { registerSwaggerPlugins } from "./swagger-plugins.js";

process.loadEnvFile?.();

type BuildAppOptions = {
  persistence?: StorePersistence;
  sessionService?: SessionService;
};

export async function buildApp(options: BuildAppOptions = {}) {
  const runtimeConfig = readRuntimeConfig();
  validateRuntimeConfig(runtimeConfig);
  const app = Fastify({ logger: true });
  const persistence = options.persistence ?? createStorePersistence();
  if (runtimeConfig.databaseUrl && !persistence.isEnabled()) {
    throw new Error("DATABASE_URL is required in production");
  }
  const runtimeSessionService =
    options.sessionService ?? (persistence.isEnabled() ? new SessionService(persistence.getStore()) : sessionService);
  await app.register(cors, { origin: true });
  await registerSwaggerPlugins(app);
  app.addHook("onReady", async () => {
    await initializeReasoningGraphStore(persistence);
    await initializePromptRegistryStore();
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(
      {
        err: error,
        method: request.method,
        url: request.url,
        params: request.params,
        query: request.query
      },
      "request_failed"
    );

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }

    const fastifyErr = error as FastifyError;
    if (Array.isArray(fastifyErr.validation) && fastifyErr.validation.length > 0) {
      return reply.code(400).send({
        error: "validation_error",
        details: fastifyErr.validation.map((issue) => ({
          path: issue.instancePath?.replace(/^\//, "").replace(/\//g, ".") || "(root)",
          message: issue.message ?? String(issue.keyword ?? "invalid")
        }))
      });
    }

    return reply.code(500).send({ error: "internal_server_error" });
  });

  const clientDir = path.join(getBrainstormApiRoot(), "dist", "client");
  if (existsSync(clientDir)) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: "/"
    });
  }

  app.get("/health", { schema: openApi.healthGet }, async (_request, reply) => {
    try {
      const persistenceHealth = await persistence.checkHealth();
      return reply.send({
        status: "ok",
        persistence: persistenceHealth.persistence
      });
    } catch (error) {
      return reply.code(503).send({
        status: "error",
        persistence: persistence.isEnabled() ? "enabled" : "disabled",
        error: error instanceof Error ? error.message : "unknown_error"
      });
    }
  });

  app.get("/ready", { schema: openApi.readyGet }, async (_request, reply) => {
    if (!persistence.isReady()) {
      return reply.code(503).send({
        status: "not_ready",
        reason: "persistence_not_initialized"
      });
    }

    try {
      const persistenceHealth = await persistence.checkHealth();
      return reply.send({
        status: "ready",
        persistence: persistenceHealth.persistence
      });
    } catch (error) {
      return reply.code(503).send({
        status: "not_ready",
        reason: error instanceof Error ? error.message : "unknown_error"
      });
    }
  });

  app.post("/api/sessions", { schema: openApi.sessionsPost }, async (request, reply) => {
    const schema = z.object({
      title: z.string().optional(),
      problemStatement: z.string().min(1),
      roles: z.array(z.string()).optional(),
      context: z.record(z.unknown()).optional()
    });
    const body = schema.parse(request.body);
    const session = persistence.isEnabled()
      ? await persistence.createSession(body)
      : await persistence.runSerializedMutation(() => runtimeSessionService.createSession(body));
    return reply.code(201).send(session);
  });

  app.post("/api/problem-statement/improve", { schema: openApi.problemStatementImprovePost }, async (request, reply) => {
    const body = z
      .object({
        problemStatement: z.string().min(1)
      })
      .parse(request.body);
    try {
      return await runtimeSessionService.improveProblemStatement(body.problemStatement);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.get("/api/sessions", { schema: openApi.sessionsListGet }, async () => {
    return persistence.listSessions();
  });

  const promptSetTypeSchema = z.enum(["manifest", "phase_prompt", "role_prompt", "schema", "tool_prompt"] satisfies [PromptSetType, ...PromptSetType[]]);

  app.get("/api/admin/prompts", { schema: openApi.adminPromptsListGet }, async () => {
    return listPromptSets();
  });

  app.get("/api/admin/prompts/:type/:name", { schema: openApi.adminPromptsDetailGet }, async (request) => {
    const params = z.object({ type: promptSetTypeSchema, name: z.string().min(1) }).parse(request.params);
    return getPromptSetDetails(params.type, params.name);
  });

  app.patch("/api/admin/prompts/:type/:name/draft", { schema: openApi.adminPromptsDraftPatch }, async (request) => {
    const params = z.object({ type: promptSetTypeSchema, name: z.string().min(1) }).parse(request.params);
    const body = z.object({ content: z.string() }).parse(request.body);
    return updatePromptDraft(params.type, params.name, body.content);
  });

  app.post("/api/admin/prompts/:type/:name/validate", { schema: openApi.adminPromptsValidatePost }, async (request) => {
    const params = z.object({ type: promptSetTypeSchema, name: z.string().min(1) }).parse(request.params);
    return validatePromptSet(params.type, params.name);
  });

  app.post("/api/admin/prompts/:type/:name/publish", { schema: openApi.adminPromptsPublishPost }, async (request, reply) => {
    const params = z.object({ type: promptSetTypeSchema, name: z.string().min(1) }).parse(request.params);
    const body = z.object({ notes: z.string().optional() }).parse(request.body ?? {});
    try {
      return await publishPromptSet(params.type, params.name, body.notes);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.post("/api/admin/prompts/:type/:name/restore", { schema: openApi.adminPromptsRestorePost }, async (request, reply) => {
    const params = z.object({ type: promptSetTypeSchema, name: z.string().min(1) }).parse(request.params);
    const body = z.object({ versionId: z.string().min(1) }).parse(request.body);
    try {
      return await restorePromptVersion(params.type, params.name, body.versionId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.get("/api/sessions/:sessionId", { schema: openApi.sessionDetailGet }, async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const session = await persistence.getSessionDetails(params.sessionId);
    if (!session) return reply.code(404).send({ error: "not_found" });
    return session;
  });

  app.patch("/api/sessions/:sessionId/problem-framing", { schema: openApi.sessionProblemFramingPatch }, async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const body = z
      .object({
        clarifiedProblemStatement: z.string().min(1).optional(),
        contextAndConstraints: z.string().min(1).optional(),
        successCriteria: z.string().min(1).optional(),
        scopeBoundaries: z.string().min(1).optional(),
        brainstormingLaunchQuestion: z.string().min(1).optional()
      })
      .refine((value) => Object.values(value).some((item) => item !== undefined), {
        message: "At least one problem framing field must be provided"
      })
      .parse(request.body);
    try {
      const session = persistence.isEnabled()
        ? await persistence.editProblemFraming(params.sessionId, body)
        : await persistence.runSerializedMutation(() => runtimeSessionService.editProblemFraming(params.sessionId, body));
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.post("/api/sessions/:sessionId/phases/:phase/start", { schema: openApi.sessionPhaseStartPost }, async (request, reply) => {
    const params = z.object({ sessionId: z.string(), phase: z.enum(phases) }).parse(request.params);
    try {
      const session = persistence.isEnabled()
        ? await persistence.startPhase(params.sessionId, params.phase, "initial", runtimeSessionService)
        : await persistence.runSerializedMutation(() => runtimeSessionService.startPhase(params.sessionId, params.phase));
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.post("/api/sessions/:sessionId/phases/:phase/rerun", { schema: openApi.sessionPhaseRerunPost }, async (request, reply) => {
    const params = z.object({ sessionId: z.string(), phase: z.enum(phases) }).parse(request.params);
    try {
      const session = persistence.isEnabled()
        ? await persistence.rerunPhase(params.sessionId, params.phase, runtimeSessionService)
        : await persistence.runSerializedMutation(() => runtimeSessionService.rerunPhase(params.sessionId, params.phase));
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.patch("/api/sessions/:sessionId/ideas/:ideaId", { schema: openApi.sessionIdeaPatch }, async (request, reply) => {
    const params = z.object({ sessionId: z.string(), ideaId: z.string() }).parse(request.params);
    const body = z.object({ text: z.string().min(1) }).parse(request.body);
    try {
      const session = persistence.isEnabled()
        ? await persistence.editIdea(params.sessionId, params.ideaId, body.text)
        : await persistence.runSerializedMutation(() => runtimeSessionService.editIdea(params.sessionId, params.ideaId, body.text));
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.patch("/api/sessions/:sessionId/clusters/:clusterId", { schema: openApi.sessionClusterPatch }, async (request, reply) => {
    const params = z.object({ sessionId: z.string(), clusterId: z.string() }).parse(request.params);
    const body = z.object({ label: z.string().min(1) }).parse(request.body);
    try {
      const session = persistence.isEnabled()
        ? await persistence.editCluster(params.sessionId, params.clusterId, body.label)
        : await persistence.runSerializedMutation(() =>
            runtimeSessionService.editCluster(params.sessionId, params.clusterId, body.label)
          );
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.post("/api/sessions/:sessionId/clusters/merge", { schema: openApi.sessionClustersMergePost }, async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const body = z
      .object({
        clusterIds: z.array(z.string()).min(2),
        label: z.string().min(1)
      })
      .parse(request.body);
    try {
      const session = persistence.isEnabled()
        ? await persistence.mergeClusters(params.sessionId, body.clusterIds, body.label)
        : await persistence.runSerializedMutation(() =>
            runtimeSessionService.mergeClusters(params.sessionId, body.clusterIds, body.label)
          );
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.post("/api/sessions/:sessionId/clusters/:clusterId/split", { schema: openApi.sessionClusterSplitPost }, async (request, reply) => {
    const params = z.object({ sessionId: z.string(), clusterId: z.string() }).parse(request.params);
    const body = z
      .object({
        splits: z
          .array(
            z.object({
              label: z.string().min(1),
              ideaIds: z.array(z.string()).min(1)
            })
          )
          .min(2)
      })
      .parse(request.body);
    try {
      const session = persistence.isEnabled()
        ? await persistence.splitCluster(params.sessionId, params.clusterId, body.splits)
        : await persistence.runSerializedMutation(() =>
            runtimeSessionService.splitCluster(params.sessionId, params.clusterId, body.splits)
          );
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.post("/api/sessions/:sessionId/decision/approve", { schema: openApi.sessionDecisionApprovePost }, async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const body = z
      .object({
        recommendation: z.string().optional(),
        rationale: z.string().optional(),
        risks: z.array(z.string()).optional(),
        nextSteps: z.array(z.string()).optional()
      })
      .optional()
      .parse(request.body ?? {});
    try {
      const session = persistence.isEnabled()
        ? await persistence.approveDecision(params.sessionId, body)
        : await persistence.runSerializedMutation(() => runtimeSessionService.approveDecision(params.sessionId, body));
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.patch("/api/sessions/:sessionId/decision-summary", { schema: openApi.sessionDecisionSummaryPatch }, async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const body = z
      .object({
        recommendation: z.string().min(1).optional(),
        rationale: z.string().min(1).optional(),
        risks: z.array(z.string().min(1)).optional(),
        nextSteps: z.array(z.string().min(1)).optional()
      })
      .refine((value) => Object.values(value).some((item) => item !== undefined), {
        message: "At least one decision field must be provided"
      })
      .parse(request.body);
    try {
      const session = persistence.isEnabled()
        ? await persistence.editDecisionSummary(params.sessionId, body)
        : await persistence.runSerializedMutation(() => runtimeSessionService.editDecisionSummary(params.sessionId, body));
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.post("/api/sessions/:sessionId/decision/reject", { schema: openApi.sessionDecisionRejectPost }, async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const body = z.object({ returnTarget: z.enum(["challenge_review", "cluster_review", "diverge_review"]) }).parse(request.body);
    try {
      const session = persistence.isEnabled()
        ? await persistence.rejectDecision(params.sessionId, body.returnTarget)
        : await persistence.runSerializedMutation(() =>
            runtimeSessionService.rejectDecision(params.sessionId, body.returnTarget)
          );
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  app.post("/api/sessions/:sessionId/exports", { schema: openApi.sessionExportPost }, async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const body = z.object({ format: z.enum(["markdown", "pdf"]).default("markdown") }).parse(request.body ?? {});
    try {
      const exportRecord = persistence.isEnabled()
        ? await persistence.exportSession(params.sessionId, body.format)
        : await persistence.runSerializedMutation(() => runtimeSessionService.exportSession(params.sessionId, body.format));
      return exportRecord;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  return app;
}

if (process.env.VITEST !== "true") {
  const runtimeConfig = readRuntimeConfig();
  const port = Number(process.env.SESSION_API_PORT ?? 3000);
  buildApp()
    .then((app) => {
      app.log.info(
        {
          port,
          envFile: ".env",
          provider: runtimeConfig.useFakeLlm ? "fake" : "gemini",
          model: runtimeConfig.geminiModel
        },
        "server_starting"
      );
      return app.listen({ port, host: "0.0.0.0" });
    })
    .catch((error) => {
      console.error("server_start_failed", error);
      process.exit(1);
    });
}
