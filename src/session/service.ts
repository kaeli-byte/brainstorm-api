import {
  type ErrorCategory,
  type ExportRecord,
  type GraphEdgeRecord,
  type GraphNodeRecord,
  type ModeratorEditRecord,
  type OutputSetRecord,
  type Phase,
  phases,
  type PhaseRunRecord,
  type SessionDetails,
  type SessionRecord
} from "../../shared/types.js";
import { makeId, nowIso } from "../../shared/utils.js";
import { InMemoryStore, store as defaultStore } from "../reasoning_graph/store.js";
import {
  createLlmProvider,
  type ClusteringOutput,
  type IdeaOutput,
  type ImproveStatementOutput,
  type ProblemFramingContext
} from "../orchestration/providers.js";
import { loadPromptConfig } from "../orchestration/promptRegistry.js";
import { loadImproveStatementPrompt } from "../orchestration/improveStatementPrompt.js";
import {
  getDefaultRoleIdsForPhase,
  getPromptVersionRefsForPhase,
  normalizeRoleIds
} from "../orchestration/promptRegistryRepository.js";
import { telemetry } from "../observability/telemetry.js";
import { readRuntimeConfig } from "../runtime/config.js";

const nextStateMap: Record<
  Phase,
  { running: SessionRecord["state"]; review: SessionRecord["state"]; failed: SessionRecord["state"] }
> = {
  diverge: { running: "diverge_running", review: "diverge_review", failed: "diverge_failed" },
  cluster: { running: "cluster_running", review: "cluster_review", failed: "cluster_failed" },
  challenge: { running: "challenge_running", review: "challenge_review", failed: "challenge_failed" },
  decide: { running: "decide_running", review: "decision_review", failed: "decide_failed" }
};

interface StagedArtifacts {
  phase: Phase | "decision";
  outputSet: OutputSetRecord;
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
}

class ClassifiedError extends Error {
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  retryCount: number;
  diagnostics?: Record<string, unknown>;

  constructor(input: {
    message: string;
    code: string;
    category: ErrorCategory;
    retryable: boolean;
    retryCount?: number;
    diagnostics?: Record<string, unknown>;
  }) {
    super(input.message);
    this.code = input.code;
    this.category = input.category;
    this.retryable = input.retryable;
    this.retryCount = input.retryCount ?? 0;
    this.diagnostics = input.diagnostics;
  }
}

function canStartPhase(state: SessionRecord["state"], phase: Phase) {
  if (phase === "diverge") return state === "draft" || state === "diverge_review" || state === "diverge_failed";
  if (phase === "cluster") return state === "diverge_review" || state === "cluster_review" || state === "cluster_failed";
  if (phase === "challenge") return state === "cluster_review" || state === "challenge_review" || state === "challenge_failed";
  return state === "challenge_review" || state === "decision_review" || state === "decide_failed";
}

function reviewStateForPhase(phase: Phase): SessionRecord["state"] {
  if (phase === "diverge") return "diverge_review";
  if (phase === "cluster") return "cluster_review";
  if (phase === "challenge") return "challenge_review";
  return "decision_review";
}

function allowedEditState(currentState: SessionRecord["state"], phase: Phase) {
  if (phase === "diverge") {
    return ["diverge_review", "cluster_review", "challenge_review", "decision_review"].includes(currentState);
  }
  if (phase === "cluster") {
    return ["cluster_review", "challenge_review", "decision_review"].includes(currentState);
  }
  return false;
}

function findActiveDecisionProposal(store: InMemoryStore, sessionId: string) {
  const activeDecision = store.getActiveOutputSet(sessionId, "decision");
  if (!activeDecision) return undefined;
  return [...store.nodes.values()].find(
    (item) => item.outputSetId === activeDecision.id && item.nodeType === "decision_proposal" && item.status === "active"
  );
}

function classifyError(error: unknown): { code: string; category: ErrorCategory; retryable: boolean } {
  const message = error instanceof Error ? error.message : "unknown_error";

  if (message.includes("stale_write")) {
    return { code: "stale_write", category: "concurrency_conflict", retryable: false };
  }
  if (message.includes("Illegal transition") || message.includes("not ready") || message.includes("not allowed")) {
    return { code: message, category: "state_guard", retryable: false };
  }
  if (message.includes("timeout")) {
    return { code: message, category: "provider_timeout", retryable: true };
  }
  if (message.includes("rate_limit")) {
    return { code: message, category: "provider_rate_limit", retryable: true };
  }
  if (message.includes("transport") || message.includes("network")) {
    return { code: message, category: "provider_transport", retryable: true };
  }
  if (message.includes("schema")) {
    return { code: message, category: "schema_validation", retryable: false };
  }
  if (message.includes("cluster")) {
    return { code: message, category: "clustering_error", retryable: false };
  }
  if (message.includes("export")) {
    return { code: message, category: "export_error", retryable: false };
  }

  return { code: message, category: "unknown_error", retryable: false };
}

async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: { maxRetries?: number; diagnostics?: Record<string, unknown> } = {}
) {
  const maxRetries = options.maxRetries ?? 1;
  const attempts: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await operation();
      return { result, retryCount: attempt, attempts };
    } catch (error) {
      const classified = classifyError(error);
      attempts.push(classified.code);
      if (!classified.retryable || attempt === maxRetries) {
        throw new ClassifiedError({
          message: classified.code,
          code: classified.code,
          category: classified.category,
          retryable: classified.retryable,
          retryCount: attempt,
          diagnostics: {
            ...options.diagnostics,
            attempts
          }
        });
      }
    }
  }

  throw new ClassifiedError({
    message: "unknown_error",
    code: "unknown_error",
    category: "unknown_error",
    retryable: false
  });
}

function markOutputSetArtifacts(store: InMemoryStore, outputSetId: string, status: OutputSetRecord["status"]) {
  for (const node of store.nodes.values()) {
    if (node.outputSetId === outputSetId && node.status === "active") {
      node.status = status;
    }
  }
  for (const edge of store.edges.values()) {
    if (edge.outputSetId === outputSetId && edge.status === "active") {
      edge.status = status;
    }
  }
}

function markDownstreamStale(store: InMemoryStore, session: SessionRecord, phase: Phase, causedByEditId?: string) {
  let staleCount = 0;
  const downstream = phases.slice(phases.indexOf(phase) + 1);
  for (const item of store.outputSets.values()) {
    if (item.sessionId === session.id && downstream.includes(item.phase as Phase) && item.status === "active") {
      item.status = "stale";
      item.causedByEditId = causedByEditId;
      markOutputSetArtifacts(store, item.id, "stale");
      staleCount += 1;
      telemetry.increment("stale_output_set_total", { phase: item.phase });
    }
  }
  if (staleCount > 0) {
    telemetry.audit({
      id: makeId("audit"),
      eventType: "PhaseOutputsMarkedStale",
      sessionId: session.id,
      phase,
      payload: { causedByEditId, staleCount },
      createdAt: nowIso()
    });
  }
}

function supersedeActiveOutput(store: InMemoryStore, sessionId: string, phase: Phase | "decision", replacementId: string) {
  for (const item of store.outputSets.values()) {
    if (item.sessionId === sessionId && item.phase === phase && item.status === "active") {
      item.status = "superseded";
      item.supersedesOutputSetId = replacementId;
      markOutputSetArtifacts(store, item.id, "superseded");
    }
  }
}

function normalizeProblemFramingContext(context?: Record<string, unknown>): ProblemFramingContext | undefined {
  const candidate = context?.problemFraming;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const framing = candidate as Record<string, unknown>;
  const clarifiedProblemStatement = String(framing.clarifiedProblemStatement ?? "").trim();
  const contextAndConstraints = String(framing.contextAndConstraints ?? "").trim();
  const successCriteria = String(framing.successCriteria ?? "").trim();
  const scopeBoundaries = String(framing.scopeBoundaries ?? "").trim();
  const brainstormingLaunchQuestion = String(framing.brainstormingLaunchQuestion ?? "").trim();

  if (
    !clarifiedProblemStatement ||
    !contextAndConstraints ||
    !successCriteria ||
    !scopeBoundaries ||
    !brainstormingLaunchQuestion
  ) {
    return undefined;
  }

  return {
    clarifiedProblemStatement,
    contextAndConstraints,
    successCriteria,
    scopeBoundaries,
    brainstormingLaunchQuestion
  };
}

export class SessionService {
  private llmProvider?: ReturnType<typeof createLlmProvider>;
  private readonly phaseRetryBudget = 1;

  constructor(private readonly store: InMemoryStore = defaultStore) {}

  private get llm() {
    this.llmProvider ??= createLlmProvider();
    return this.llmProvider;
  }

  private set llm(provider: ReturnType<typeof createLlmProvider>) {
    this.llmProvider = provider;
  }

  createSession(input: { title?: string; problemStatement: string; roles?: string[]; context?: Record<string, unknown> }) {
    const id = makeId("session");
    const timestamp = nowIso();
    const session: SessionRecord = {
      id,
      title: input.title ?? "Untitled session",
      problemStatement: input.problemStatement,
      roles: normalizeRoleIds(input.roles ?? getDefaultRoleIdsForPhase("diverge")),
      context: input.context,
      state: "draft",
      activeOutputSetIds: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.store.sessions.set(id, session);
    telemetry.audit({
      id: makeId("audit"),
      eventType: "SessionCreated",
      sessionId: id,
      payload: { title: session.title, roleCount: session.roles.length },
      createdAt: nowIso()
    });
    return session;
  }

  getSession(sessionId: string): SessionDetails | undefined {
    return this.store.getSessionDetails(sessionId);
  }

  private getProblemFramingContext(session: SessionRecord) {
    return normalizeProblemFramingContext(session.context);
  }

  async improveProblemStatement(problemStatement: string): Promise<ImproveStatementOutput> {
    const rawStatement = problemStatement.trim();
    if (!rawStatement) {
      throw new Error("problem_statement_required");
    }
    return this.llm.improveProblemStatement({
      prompt: loadImproveStatementPrompt(),
      rawStatement
    });
  }

  async startPhase(sessionId: string, phase: Phase, triggerType: PhaseRunRecord["triggerType"] = "initial") {
    const session = this.store.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    if (!canStartPhase(session.state, phase)) throw new Error(`Illegal transition for ${phase} from ${session.state}`);

    const attemptNumber =
      [...this.store.phaseRuns.values()].filter((item) => item.sessionId === sessionId && item.phase === phase).length + 1;
    const config = loadPromptConfig(phase);
    const runtimeConfig = readRuntimeConfig();
    const run: PhaseRunRecord = {
      id: makeId("run"),
      sessionId,
      phase,
      status: "running",
      attemptNumber,
      triggerType,
      provider: runtimeConfig.geminiApiKey && !runtimeConfig.useFakeLlm ? "gemini" : "fake",
      model: config.model,
      promptTemplateVersion: config.templateVersion,
      roleConfigVersion: config.roleConfigVersion,
      schemaVersion: config.schemaVersion,
      promptVersionRefs: getPromptVersionRefsForPhase(phase),
      startedAt: nowIso()
    };

    const stateBefore = session.state;
    session.state = nextStateMap[phase].running;
    session.updatedAt = nowIso();
    this.store.phaseRuns.set(run.id, run);
    telemetry.audit({
      id: makeId("audit"),
      eventType: "PhaseRunStarted",
      sessionId,
      phase,
      runId: run.id,
      payload: {
        triggerType,
        provider: run.provider,
        model: run.model,
        stateBefore,
        stateAfter: session.state
      },
      createdAt: nowIso()
    });

    try {
      const staged =
        phase === "diverge"
          ? await this.runDiverge(session, run)
          : phase === "cluster"
            ? await this.runCluster(session, run)
            : phase === "challenge"
              ? await this.runChallenge(session, run)
              : await this.runDecide(session, run);

      this.activateArtifacts(session, staged);
      run.status = "completed";
      run.completedAt = nowIso();
      session.state = nextStateMap[phase].review;
      session.updatedAt = nowIso();
      const durationMs = Date.parse(run.completedAt) - Date.parse(run.startedAt);
      telemetry.increment("phase_run_total", { phase, status: "success" });
      telemetry.timing("phase_run_duration_seconds", durationMs / 1000, { phase, status: "success" });
      telemetry.audit({
        id: makeId("audit"),
        eventType: "PhaseRunCompleted",
        sessionId,
        phase,
        runId: run.id,
        payload: {
          outputSetId: staged.outputSet.id,
          triggerType,
          stateAfter: session.state,
          durationMs
        },
        createdAt: nowIso()
      });
    } catch (error) {
      run.status = "failed";
      const classified = classifyError(error);
      run.errorCode = classified.code;
      run.errorCategory = classified.category;
      run.retryCount = error instanceof ClassifiedError ? error.retryCount : 0;
      run.diagnostics =
        error instanceof ClassifiedError
          ? error.diagnostics
          : {
              attempts: [classified.code]
            };
      run.completedAt = nowIso();
      session.state = nextStateMap[phase].failed;
      session.updatedAt = nowIso();
      const durationMs = Date.parse(run.completedAt) - Date.parse(run.startedAt);
      telemetry.increment("phase_run_total", { phase, status: "failure" });
      telemetry.timing("phase_run_duration_seconds", durationMs / 1000, { phase, status: "failure" });
      telemetry.audit({
        id: makeId("audit"),
        eventType: "PhaseRunFailed",
        sessionId,
        phase,
        runId: run.id,
        payload: {
          errorCode: run.errorCode,
          errorCategory: run.errorCategory,
          retryCount: run.retryCount ?? 0,
          durationMs
        },
        createdAt: nowIso()
      });
      throw error;
    }

    return this.getSession(sessionId)!;
  }

  async rerunPhase(sessionId: string, phase: Phase) {
    return this.startPhase(sessionId, phase, "rerun");
  }

  private createOutputSet(session: SessionRecord, phase: Phase | "decision", runId: string): OutputSetRecord {
    return {
      id: makeId("output"),
      sessionId: session.id,
      phase,
      runId,
      status: "active",
      createdAt: nowIso()
    };
  }

  private activateArtifacts(session: SessionRecord, staged: StagedArtifacts) {
    supersedeActiveOutput(this.store, session.id, staged.phase, staged.outputSet.id);
    session.activeOutputSetIds[staged.phase] = staged.outputSet.id;
    this.store.outputSets.set(staged.outputSet.id, staged.outputSet);
    staged.nodes.forEach((node) => this.store.nodes.set(node.id, node));
    staged.edges.forEach((edge) => this.store.edges.set(edge.id, edge));
  }

  private async runDiverge(session: SessionRecord, run: PhaseRunRecord): Promise<StagedArtifacts> {
    const config = loadPromptConfig("diverge");
    const outputSet = this.createOutputSet(session, "diverge", run.id);
    const roleIdeas: { role: string; ideas: IdeaOutput[] }[] = [];

    for (const roleId of normalizeRoleIds(session.roles)) {
      const roleDefinition = config.roleDefinitions[roleId];
      if (!roleDefinition) {
        throw new Error(`Missing role configuration for ${roleId}`);
      }
      try {
        const { result, retryCount } = await executeWithRetry(
          () =>
            this.llm.generateIdeas({
              problemStatement: session.problemStatement,
              role: roleDefinition.name,
              roleId,
              framingContext: this.getProblemFramingContext(session),
              promptConfig: config,
              roleDefinition
            }),
          { maxRetries: this.phaseRetryBudget, diagnostics: { roleId } }
        );
        run.retryCount = (run.retryCount ?? 0) + retryCount;
        if (retryCount > 0) {
          telemetry.increment("phase_retry_total", { phase: "diverge", reason: "provider_timeout" }, retryCount);
        }
        roleIdeas.push({ role: roleDefinition.name, ideas: result });
      } catch (error) {
        if (error instanceof ClassifiedError) {
          error.diagnostics = {
            ...error.diagnostics,
            partialOutputs: roleIdeas.map((item) => ({
              role: item.role,
              ideaCount: item.ideas.length
            }))
          };
        }
        throw error;
      }
    }

    const flattenedIdeas = roleIdeas.flatMap(({ role, ideas }) => ideas.map((idea) => ({ role, idea })));

    const nodes: GraphNodeRecord[] = flattenedIdeas.map(({ role, idea }, index) => ({
      id: makeId("idea"),
      sessionId: session.id,
      phase: "diverge",
      runId: run.id,
      outputSetId: outputSet.id,
      nodeType: "idea",
      status: "active",
      sourceRole: role,
      content: { title: idea.title, text: idea.text, rationale: idea.rationale, ideaId: index + 1 },
      createdAt: nowIso()
    }));

    return { phase: "diverge", outputSet, nodes, edges: [] };
  }

  private async runCluster(session: SessionRecord, run: PhaseRunRecord): Promise<StagedArtifacts> {
    const config = loadPromptConfig("cluster");
    const activeDiverge = this.store.getActiveOutputSet(session.id, "diverge");
    if (!activeDiverge) throw new Error("missing_diverge_output");

    const ideaNodes = [...this.store.nodes.values()].filter(
      (item) => item.outputSetId === activeDiverge.id && item.nodeType === "idea" && item.status === "active"
    );
    const { result: clustering, retryCount } = await executeWithRetry(
      () =>
        this.llm.generateClusters({
          problemStatement: session.problemStatement,
          ideas: ideaNodes.map((idea) => ({
            id: idea.id,
            title: typeof idea.content.title === "string" ? idea.content.title : undefined,
            text: String(idea.content.text ?? ""),
            rationale: typeof idea.content.rationale === "string" ? idea.content.rationale : undefined,
            sourceRole: idea.sourceRole
          })),
          framingContext: this.getProblemFramingContext(session),
          promptConfig: config
        }),
      { maxRetries: this.phaseRetryBudget, diagnostics: { ideaCount: ideaNodes.length } }
    );
    run.retryCount = (run.retryCount ?? 0) + retryCount;
    if (retryCount > 0) {
      telemetry.increment("phase_retry_total", { phase: "cluster", reason: "provider_timeout" }, retryCount);
    }
    const outputSet = this.createOutputSet(session, "cluster", run.id);
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];
    const validIdeaIds = new Set(ideaNodes.map((idea) => idea.id));
    const assignedIdeaIds = new Set<string>();
    const normalized = clustering as ClusteringOutput;

    normalized.clusters.forEach((cluster, index) => {
      const memberIdeaIds = Array.from(
        new Set((Array.isArray(cluster.memberIdeaIds) ? cluster.memberIdeaIds : []).map(String).filter((ideaId) => validIdeaIds.has(ideaId)))
      );
      const bridgeIdeaIds = Array.from(
        new Set(
          (Array.isArray(cluster.bridgeIdeaIds) ? cluster.bridgeIdeaIds : [])
            .map(String)
            .filter((ideaId) => validIdeaIds.has(ideaId) && !memberIdeaIds.includes(ideaId))
        )
      );
      const combinedIdeaIds = [...memberIdeaIds, ...bridgeIdeaIds];
      if (combinedIdeaIds.length === 0) return;

      combinedIdeaIds.forEach((ideaId) => assignedIdeaIds.add(ideaId));
      const clusterNode: GraphNodeRecord = {
        id: makeId("cluster"),
        sessionId: session.id,
        phase: "cluster",
        runId: run.id,
        outputSetId: outputSet.id,
        nodeType: "cluster",
        status: "active",
        content: {
          clusterKey: typeof cluster.id === "string" && cluster.id.trim() ? cluster.id.trim() : `cluster-${index + 1}`,
          label: String(cluster.label ?? "").trim() || `Cluster ${index + 1}`,
          summary: String(cluster.summary ?? "").trim(),
          rationale: String(cluster.rationale ?? "").trim(),
          confidence:
            typeof cluster.confidence === "number" && Number.isFinite(cluster.confidence)
              ? Math.max(0, Math.min(1, Number(cluster.confidence)))
              : 0,
          memberIdeaIds,
          bridgeIdeaIds,
          ideaIds: combinedIdeaIds
        },
        createdAt: nowIso()
      };
      nodes.push(clusterNode);

      memberIdeaIds.forEach((ideaId) => {
        edges.push({
          id: makeId("edge"),
          sessionId: session.id,
          phase: "cluster",
          runId: run.id,
          outputSetId: outputSet.id,
          edgeType: "belongs_to_cluster",
          fromNodeId: ideaId,
          toNodeId: clusterNode.id,
          status: "active"
        });
      });

      bridgeIdeaIds.forEach((ideaId) => {
        edges.push({
          id: makeId("edge"),
          sessionId: session.id,
          phase: "cluster",
          runId: run.id,
          outputSetId: outputSet.id,
          edgeType: "bridges_cluster",
          fromNodeId: ideaId,
          toNodeId: clusterNode.id,
          status: "active"
        });
      });
    });

    const unclusteredIdeaIds = Array.from(
      new Set(
        (Array.isArray(normalized.unclusteredIdeaIds) ? normalized.unclusteredIdeaIds : [])
          .map(String)
          .filter((ideaId) => validIdeaIds.has(ideaId) && !assignedIdeaIds.has(ideaId))
      )
    );
    const missingIdeaIds = [...validIdeaIds].filter((ideaId) => !assignedIdeaIds.has(ideaId) && !unclusteredIdeaIds.includes(ideaId));
    run.diagnostics = {
      ...(run.diagnostics ?? {}),
      clusterCount: nodes.length,
      unclusteredIdeaIds: [...unclusteredIdeaIds, ...missingIdeaIds]
    };

    return { phase: "cluster", outputSet, nodes, edges };
  }

  private async runChallenge(session: SessionRecord, run: PhaseRunRecord): Promise<StagedArtifacts> {
    const config = loadPromptConfig("challenge");
    const clusterOutput = this.store.getActiveOutputSet(session.id, "cluster");
    if (!clusterOutput) throw new Error("missing_cluster_output");
    for (const roleId of config.roles) {
      if (!config.roleDefinitions[roleId]) {
        throw new Error(`Missing role configuration for ${roleId}`);
      }
    }

    const clusters = [...this.store.nodes.values()]
      .filter((item) => item.outputSetId === clusterOutput.id && item.nodeType === "cluster" && item.status === "active")
      .map((cluster) => ({
        id: cluster.id,
        label: String(cluster.content.label),
        ideas: Array.isArray(cluster.content.memberIdeaIds)
          ? cluster.content.memberIdeaIds.map(String)
          : Array.isArray(cluster.content.ideaIds)
            ? cluster.content.ideaIds.map(String)
            : []
      }));

    const { result: critiques, retryCount } = await executeWithRetry(
      () =>
        this.llm.generateCritiques({
          problemStatement: session.problemStatement,
          clusters,
          framingContext: this.getProblemFramingContext(session)
        }),
      { maxRetries: this.phaseRetryBudget, diagnostics: { clusterCount: clusters.length } }
    );
    run.retryCount = (run.retryCount ?? 0) + retryCount;
    if (retryCount > 0) {
      telemetry.increment("phase_retry_total", { phase: "challenge", reason: "provider_timeout" }, retryCount);
    }

    const outputSet = this.createOutputSet(session, "challenge", run.id);
    const nodes: GraphNodeRecord[] = [];
    const edges: GraphEdgeRecord[] = [];

    critiques.forEach((critique) => {
      const node: GraphNodeRecord = {
        id: makeId("critique"),
        sessionId: session.id,
        phase: "challenge",
        runId: run.id,
        outputSetId: outputSet.id,
        nodeType: "critique",
        status: "active",
        content: { text: critique.text, riskLevel: critique.riskLevel, targetIds: critique.targetIds },
        createdAt: nowIso()
      };
      nodes.push(node);

      critique.targetIds.forEach((targetId) => {
        edges.push({
          id: makeId("edge"),
          sessionId: session.id,
          phase: "challenge",
          runId: run.id,
          outputSetId: outputSet.id,
          edgeType: "challenges",
          fromNodeId: node.id,
          toNodeId: targetId,
          status: "active"
        });
      });
    });

    return { phase: "challenge", outputSet, nodes, edges };
  }

  private async runDecide(session: SessionRecord, run: PhaseRunRecord): Promise<StagedArtifacts> {
    const config = loadPromptConfig("decide");
    const clusterOutput = this.store.getActiveOutputSet(session.id, "cluster");
    const challengeOutput = this.store.getActiveOutputSet(session.id, "challenge");
    if (!clusterOutput || !challengeOutput) throw new Error("missing_decide_inputs");
    for (const roleId of config.roles) {
      if (!config.roleDefinitions[roleId]) {
        throw new Error(`Missing role configuration for ${roleId}`);
      }
    }

    const clusters = [...this.store.nodes.values()]
      .filter((item) => item.outputSetId === clusterOutput.id && item.nodeType === "cluster" && item.status === "active")
      .map((cluster) => ({ id: cluster.id, label: String(cluster.content.label) }));
    const critiques = [...this.store.nodes.values()]
      .filter((item) => item.outputSetId === challengeOutput.id && item.nodeType === "critique" && item.status === "active")
      .map((item) => String(item.content.text));

    const { result: decision, retryCount } = await executeWithRetry(
      () =>
        this.llm.generateDecision({
          problemStatement: session.problemStatement,
          clusters,
          critiques,
          framingContext: this.getProblemFramingContext(session)
        }),
      { maxRetries: this.phaseRetryBudget, diagnostics: { clusterCount: clusters.length, critiqueCount: critiques.length } }
    );
    run.retryCount = (run.retryCount ?? 0) + retryCount;
    if (retryCount > 0) {
      telemetry.increment("phase_retry_total", { phase: "decide", reason: "provider_timeout" }, retryCount);
    }

    const outputSet = this.createOutputSet(session, "decision", run.id);
    const proposalNode: GraphNodeRecord = {
      id: makeId("decision"),
      sessionId: session.id,
      phase: "decision",
      runId: run.id,
      outputSetId: outputSet.id,
      nodeType: "decision_proposal",
      status: "active",
      content: decision as unknown as Record<string, unknown>,
      createdAt: nowIso()
    };

    return { phase: "decision", outputSet, nodes: [proposalNode], edges: [] };
  }

  editIdea(sessionId: string, ideaId: string, text: string) {
    const session = this.store.sessions.get(sessionId);
    const node = this.store.nodes.get(ideaId);
    if (!session || !node || node.sessionId !== sessionId || node.phase !== "diverge") throw new Error("Idea not found");
    if (!allowedEditState(session.state, "diverge")) throw new Error("Edit not allowed in current state");
    if (node.status !== "active" || node.outputSetId !== session.activeOutputSetIds.diverge) throw new Error("stale_write");

    const edit: ModeratorEditRecord = {
      id: makeId("edit"),
      sessionId,
      phase: "diverge",
      editedNodeId: ideaId,
      editType: "idea_text_update",
      before: { ...node.content },
      after: { ...node.content, text },
      createdAt: nowIso()
    };
    this.store.edits.set(edit.id, edit);

    node.status = "superseded";
    const revisedNode: GraphNodeRecord = {
      ...node,
      id: makeId("idea"),
      status: "active",
      content: { ...node.content, text },
      derivedFromNodeId: node.id,
      createdAt: nowIso()
    };
    this.store.nodes.set(revisedNode.id, revisedNode);

    markDownstreamStale(this.store, session, "diverge", edit.id);
    session.state = reviewStateForPhase("diverge");
    session.updatedAt = nowIso();
    return this.getSession(sessionId)!;
  }

  editCluster(sessionId: string, clusterId: string, label: string) {
    const session = this.store.sessions.get(sessionId);
    const node = this.store.nodes.get(clusterId);
    if (!session || !node || node.sessionId !== sessionId || node.phase !== "cluster") throw new Error("Cluster not found");
    if (!allowedEditState(session.state, "cluster")) throw new Error("Edit not allowed in current state");
    if (node.status !== "active" || node.outputSetId !== session.activeOutputSetIds.cluster) throw new Error("stale_write");

    const edit: ModeratorEditRecord = {
      id: makeId("edit"),
      sessionId,
      phase: "cluster",
      editedNodeId: clusterId,
      editType: "cluster_label_update",
      before: { ...node.content },
      after: { ...node.content, label },
      createdAt: nowIso()
    };
    this.store.edits.set(edit.id, edit);

    node.status = "superseded";
    const revisedNode: GraphNodeRecord = {
      ...node,
      id: makeId("cluster"),
      status: "active",
      content: { ...node.content, label },
      derivedFromNodeId: node.id,
      createdAt: nowIso()
    };
    this.store.nodes.set(revisedNode.id, revisedNode);

    for (const edge of [...this.store.edges.values()]) {
      if (edge.toNodeId === node.id && edge.status === "active") {
        edge.status = "superseded";
        this.store.edges.set(makeId("edge"), {
          ...edge,
          id: makeId("edge"),
          toNodeId: revisedNode.id,
          status: "active"
        });
      }
    }

    markDownstreamStale(this.store, session, "cluster", edit.id);
    session.state = reviewStateForPhase("cluster");
    session.updatedAt = nowIso();
    return this.getSession(sessionId)!;
  }

  mergeClusters(sessionId: string, clusterIds: string[], label: string) {
    const session = this.store.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    if (!allowedEditState(session.state, "cluster")) throw new Error("Edit not allowed in current state");
    if (clusterIds.length < 2) throw new Error("At least two clusters are required to merge");

    const activeOutputSetId = session.activeOutputSetIds.cluster;
    const clusters = clusterIds.map((clusterId) => this.store.nodes.get(clusterId));
    if (
      clusters.some(
        (node) =>
          !node ||
          node.sessionId !== sessionId ||
          node.phase !== "cluster" ||
          node.nodeType !== "cluster" ||
          node.status !== "active" ||
          node.outputSetId !== activeOutputSetId
      )
    ) {
      throw new Error("Cluster not found");
    }

    const edit: ModeratorEditRecord = {
      id: makeId("edit"),
      sessionId,
      phase: "cluster",
      editType: "cluster_merge",
      before: { clusterIds },
      after: { label },
      createdAt: nowIso()
    };
    this.store.edits.set(edit.id, edit);

    const ideaIds = new Set<string>();
    const bridgeIdeaIds = new Set<string>();
    const summaries: string[] = [];
    const rationales: string[] = [];
    let maxConfidence = 0;
    for (const cluster of clusters as GraphNodeRecord[]) {
      cluster.status = "superseded";
      const clusterIdeaIds = Array.isArray(cluster.content.memberIdeaIds)
        ? cluster.content.memberIdeaIds.map(String)
        : Array.isArray(cluster.content.ideaIds)
          ? cluster.content.ideaIds.map(String)
          : [];
      const clusterBridgeIdeaIds = Array.isArray(cluster.content.bridgeIdeaIds) ? cluster.content.bridgeIdeaIds.map(String) : [];
      clusterIdeaIds.forEach((ideaId) => ideaIds.add(ideaId));
      clusterBridgeIdeaIds.forEach((ideaId) => {
        if (!ideaIds.has(ideaId)) bridgeIdeaIds.add(ideaId);
      });
      if (typeof cluster.content.summary === "string" && cluster.content.summary.trim()) summaries.push(cluster.content.summary.trim());
      if (typeof cluster.content.rationale === "string" && cluster.content.rationale.trim()) rationales.push(cluster.content.rationale.trim());
      if (typeof cluster.content.confidence === "number" && Number.isFinite(cluster.content.confidence)) {
        maxConfidence = Math.max(maxConfidence, Number(cluster.content.confidence));
      }
    }

    for (const edge of [...this.store.edges.values()]) {
      if (clusterIds.includes(edge.toNodeId) && edge.status === "active") {
        edge.status = "superseded";
      }
    }

    const mergedNode: GraphNodeRecord = {
      id: makeId("cluster"),
      sessionId,
      phase: "cluster",
      runId: (clusters[0] as GraphNodeRecord).runId,
      outputSetId: activeOutputSetId!,
      nodeType: "cluster",
      status: "active",
      content: {
        label,
        summary: summaries[0] ?? `Merged cluster containing ${ideaIds.size + bridgeIdeaIds.size} related ideas.`,
        rationale: rationales[0] ?? "Merged by moderator review.",
        confidence: maxConfidence || 1,
        memberIdeaIds: [...ideaIds],
        bridgeIdeaIds: [...bridgeIdeaIds].filter((ideaId) => !ideaIds.has(ideaId)),
        ideaIds: [...ideaIds, ...[...bridgeIdeaIds].filter((ideaId) => !ideaIds.has(ideaId))]
      },
      createdAt: nowIso()
    };
    this.store.nodes.set(mergedNode.id, mergedNode);

    for (const ideaId of ideaIds) {
      const edge: GraphEdgeRecord = {
        id: makeId("edge"),
        sessionId,
        phase: "cluster",
        runId: mergedNode.runId,
        outputSetId: mergedNode.outputSetId,
        edgeType: "belongs_to_cluster",
        fromNodeId: ideaId,
        toNodeId: mergedNode.id,
        status: "active"
      };
      this.store.edges.set(edge.id, edge);
    }

    for (const ideaId of bridgeIdeaIds) {
      if (ideaIds.has(ideaId)) continue;
      const edge: GraphEdgeRecord = {
        id: makeId("edge"),
        sessionId,
        phase: "cluster",
        runId: mergedNode.runId,
        outputSetId: mergedNode.outputSetId,
        edgeType: "bridges_cluster",
        fromNodeId: ideaId,
        toNodeId: mergedNode.id,
        status: "active"
      };
      this.store.edges.set(edge.id, edge);
    }

    markDownstreamStale(this.store, session, "cluster", edit.id);
    session.state = reviewStateForPhase("cluster");
    session.updatedAt = nowIso();
    return this.getSession(sessionId)!;
  }

  splitCluster(sessionId: string, clusterId: string, splits: { label: string; ideaIds: string[] }[]) {
    const session = this.store.sessions.get(sessionId);
    const cluster = this.store.nodes.get(clusterId);
    if (!session || !cluster || cluster.sessionId !== sessionId || cluster.phase !== "cluster" || cluster.nodeType !== "cluster") {
      throw new Error("Cluster not found");
    }
    if (!allowedEditState(session.state, "cluster")) throw new Error("Edit not allowed in current state");
    if (cluster.status !== "active" || cluster.outputSetId !== session.activeOutputSetIds.cluster) throw new Error("stale_write");
    if (splits.length < 2) throw new Error("At least two split groups are required");

    const originalIdeaIds = Array.isArray(cluster.content.ideaIds) ? cluster.content.ideaIds.map(String) : [];
    const providedIdeaIds = splits.flatMap((split) => split.ideaIds);
    const uniqueProvidedIdeaIds = new Set(providedIdeaIds);
    if (
      uniqueProvidedIdeaIds.size !== originalIdeaIds.length ||
      originalIdeaIds.some((ideaId) => !uniqueProvidedIdeaIds.has(ideaId)) ||
      providedIdeaIds.length !== originalIdeaIds.length
    ) {
      throw new Error("Split groups must partition the original cluster ideas exactly");
    }

    const edit: ModeratorEditRecord = {
      id: makeId("edit"),
      sessionId,
      phase: "cluster",
      editedNodeId: clusterId,
      editType: "cluster_split",
      before: { ideaIds: originalIdeaIds, label: cluster.content.label },
      after: { splits },
      createdAt: nowIso()
    };
    this.store.edits.set(edit.id, edit);

    cluster.status = "superseded";
    for (const edge of [...this.store.edges.values()]) {
      if (edge.toNodeId === clusterId && edge.status === "active") {
        edge.status = "superseded";
      }
    }

    for (const split of splits) {
      const node: GraphNodeRecord = {
        id: makeId("cluster"),
        sessionId,
        phase: "cluster",
        runId: cluster.runId,
        outputSetId: cluster.outputSetId,
        nodeType: "cluster",
        status: "active",
        content: {
          label: split.label,
          summary: `Moderator split from ${String(cluster.content.label ?? "cluster")}.`,
          rationale: "Created by moderator split.",
          confidence: 1,
          memberIdeaIds: split.ideaIds,
          bridgeIdeaIds: [],
          ideaIds: split.ideaIds
        },
        derivedFromNodeId: cluster.id,
        createdAt: nowIso()
      };
      this.store.nodes.set(node.id, node);

      for (const ideaId of split.ideaIds) {
        const edge: GraphEdgeRecord = {
          id: makeId("edge"),
          sessionId,
          phase: "cluster",
          runId: cluster.runId,
          outputSetId: cluster.outputSetId,
          edgeType: "belongs_to_cluster",
          fromNodeId: ideaId,
          toNodeId: node.id,
          status: "active"
        };
        this.store.edges.set(edge.id, edge);
      }
    }

    markDownstreamStale(this.store, session, "cluster", edit.id);
    session.state = reviewStateForPhase("cluster");
    session.updatedAt = nowIso();
    return this.getSession(sessionId)!;
  }

  editDecisionSummary(
    sessionId: string,
    patch: { recommendation?: string; rationale?: string; risks?: string[]; nextSteps?: string[] }
  ) {
    const session = this.store.sessions.get(sessionId);
    if (!session || session.state !== "decision_review") throw new Error("Decision not ready");

    const proposal = findActiveDecisionProposal(this.store, sessionId);
    if (!proposal) throw new Error("Missing proposal");

    const nextContent = {
      ...proposal.content,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
    };

    const edit: ModeratorEditRecord = {
      id: makeId("edit"),
      sessionId,
      phase: "decision",
      editedNodeId: proposal.id,
      editType: "decision_summary_update",
      before: { ...proposal.content },
      after: nextContent,
      createdAt: nowIso()
    };
    this.store.edits.set(edit.id, edit);

    proposal.status = "superseded";
    const revisedNode: GraphNodeRecord = {
      ...proposal,
      id: makeId("decision"),
      status: "active",
      content: nextContent,
      derivedFromNodeId: proposal.id,
      createdAt: nowIso()
    };
    this.store.nodes.set(revisedNode.id, revisedNode);

    session.updatedAt = nowIso();
    return this.getSession(sessionId)!;
  }

  editProblemFraming(sessionId: string, patch: Partial<ProblemFramingContext>) {
    const session = this.store.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    const currentFraming = this.getProblemFramingContext(session);
    if (!currentFraming) throw new Error("Problem framing not found");

    const nextFraming = {
      ...currentFraming,
      ...Object.fromEntries(
        Object.entries(patch)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value).trim()])
      )
    };

    if (Object.values(nextFraming).some((value) => value.length === 0)) {
      throw new Error("Problem framing fields must be non-empty");
    }

    const edit: ModeratorEditRecord = {
      id: makeId("edit"),
      sessionId,
      phase: "diverge",
      editType: "problem_framing_update",
      before: { problemFraming: currentFraming },
      after: { problemFraming: nextFraming },
      createdAt: nowIso()
    };
    this.store.edits.set(edit.id, edit);

    session.context = {
      ...(session.context ?? {}),
      problemFraming: nextFraming
    };
    session.problemStatement = nextFraming.clarifiedProblemStatement;
    session.updatedAt = nowIso();
    return this.getSession(sessionId)!;
  }

  approveDecision(
    sessionId: string,
    override?: { recommendation?: string; rationale?: string; risks?: string[]; nextSteps?: string[] }
  ) {
    const session = this.store.sessions.get(sessionId);
    if (!session || session.state !== "decision_review") throw new Error("Decision not ready");

    const activeChallenge = this.store.getActiveOutputSet(sessionId, "challenge");
    const activeDecision = this.store.getActiveOutputSet(sessionId, "decision");
    const staleDownstream = activeChallenge?.status === "stale" || activeDecision?.status === "stale";
    if (staleDownstream) throw new Error("Decision inputs are stale");

    const proposal = findActiveDecisionProposal(this.store, sessionId);
    if (!proposal) throw new Error("Missing proposal");

    const approvedOutputSet = this.createOutputSet(session, "decision", proposal.runId);
    this.activateArtifacts(session, { phase: "decision", outputSet: approvedOutputSet, nodes: [], edges: [] });
    const snapshot: GraphNodeRecord = {
      ...proposal,
      id: makeId("snapshot"),
      outputSetId: approvedOutputSet.id,
      nodeType: "decision_snapshot",
      status: "active",
      content: { ...proposal.content, ...override },
      createdAt: nowIso()
    };
    this.store.nodes.set(snapshot.id, snapshot);
    session.state = "approved";
    session.updatedAt = nowIso();
    telemetry.increment("session_completion_total", { final_state: "approved" });
    telemetry.audit({
      id: makeId("audit"),
      eventType: "DecisionApproved",
      sessionId,
      phase: "decide",
      payload: { outputSetId: approvedOutputSet.id },
      createdAt: nowIso()
    });
    return this.getSession(sessionId)!;
  }

  rejectDecision(sessionId: string, returnTarget: "challenge_review" | "cluster_review" | "diverge_review") {
    const session = this.store.sessions.get(sessionId);
    if (!session || session.state !== "decision_review") throw new Error("Decision not ready");
    const activeDecision = this.store.getActiveOutputSet(sessionId, "decision");
    if (activeDecision) {
      activeDecision.status = "rejected";
      markOutputSetArtifacts(this.store, activeDecision.id, "rejected");
    }
    session.state = returnTarget;
    session.updatedAt = nowIso();
    telemetry.increment("decision_rejection_total", { return_target: returnTarget });
    telemetry.audit({
      id: makeId("audit"),
      eventType: "DecisionRejected",
      sessionId,
      phase: "decide",
      payload: { returnTarget },
      createdAt: nowIso()
    });
    return this.getSession(sessionId)!;
  }

  exportSession(sessionId: string, format: "markdown" | "pdf" = "markdown") {
    const session = this.store.sessions.get(sessionId);
    if (!session || (session.state !== "approved" && session.state !== "exported")) {
      throw new Error("Export not allowed");
    }
    telemetry.audit({
      id: makeId("audit"),
      eventType: "ExportRequested",
      sessionId,
      payload: { format, sessionState: session.state },
      createdAt: nowIso()
    });

    const decisionSet = this.store.getActiveOutputSet(sessionId, "decision");
    const snapshot = decisionSet
      ? [...this.store.nodes.values()].find(
          (item) => item.outputSetId === decisionSet.id && item.nodeType === "decision_snapshot" && item.status === "active"
        )
      : undefined;

    if (!snapshot) {
      const failedExport: ExportRecord = {
        id: makeId("export"),
        sessionId,
        format,
        status: "failed",
        artifact: "",
        errorCode: "missing_approved_snapshot",
        retryCount: 0,
        createdAt: nowIso()
      };
      this.store.exports.set(failedExport.id, failedExport);
      telemetry.increment("export_total", { format, status: "failure" });
      telemetry.audit({
        id: makeId("audit"),
        eventType: "ExportFailed",
        sessionId,
        payload: { format, errorCode: failedExport.errorCode },
        createdAt: nowIso()
      });
      throw new Error("Missing approved snapshot");
    }

    try {
      const { result: artifact, retryCount } = this.buildExportArtifact(session, snapshot, format);
      const exportRecord: ExportRecord = {
        id: makeId("export"),
        sessionId,
        format,
        status: "completed",
        artifact,
        retryCount,
        createdAt: nowIso()
      };
      this.store.exports.set(exportRecord.id, exportRecord);
      session.state = "exported";
      session.updatedAt = nowIso();
      telemetry.increment("export_total", { format, status: "success" });
      telemetry.increment("session_completion_total", { final_state: "exported" });
      telemetry.audit({
        id: makeId("audit"),
        eventType: "ExportCompleted",
        sessionId,
        payload: { format, exportId: exportRecord.id },
        createdAt: nowIso()
      });
      return exportRecord;
    } catch (error) {
      const classified = classifyError(error);
      const failedExport: ExportRecord = {
        id: makeId("export"),
        sessionId,
        format,
        status: "failed",
        artifact: "",
        errorCode: classified.code,
        retryCount: error instanceof ClassifiedError ? error.retryCount : 0,
        createdAt: nowIso()
      };
      this.store.exports.set(failedExport.id, failedExport);
      session.state = "approved";
      session.updatedAt = nowIso();
      telemetry.increment("export_total", { format, status: "failure" });
      telemetry.audit({
        id: makeId("audit"),
        eventType: "ExportFailed",
        sessionId,
        payload: { format, errorCode: failedExport.errorCode },
        createdAt: nowIso()
      });
      throw error;
    }
  }

  private buildExportArtifact(session: SessionRecord, snapshot: GraphNodeRecord, format: "markdown" | "pdf") {
    if (format === "markdown" && String(snapshot.content.recommendation ?? "").includes("[[EXPORT_FAIL]]")) {
      throw new ClassifiedError({
        message: "export_render_failed",
        code: "export_render_failed",
        category: "export_error",
        retryable: false
      });
    }

    const artifact =
      format === "markdown"
        ? `# ${session.title}\n\n## Problem\n${session.problemStatement}\n\n## Decision\n${String(snapshot.content.recommendation ?? "")}\n`
        : `<html><body><h1>${session.title}</h1><p>${String(snapshot.content.recommendation ?? "")}</p></body></html>`;
    return { result: artifact, retryCount: 0 };
  }
}

export const sessionService = new SessionService();
