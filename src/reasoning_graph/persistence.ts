import { Pool, type PoolClient } from "pg";
import type {
  ExportRecord,
  GraphEdgeRecord,
  GraphNodeRecord,
  ModeratorEditRecord,
  OutputSetRecord,
  PhaseRunRecord,
  SessionDetails,
  SessionRecord,
  SessionSummary
} from "../../shared/types.js";
import { makeId, nowIso } from "../../shared/utils.js";
import { telemetry } from "../observability/telemetry.js";
import { InMemoryStore } from "./store.js";
import type { ProblemFramingContext } from "../orchestration/providers.js";
import { SessionService } from "../session/service.js";
import {
  getDefaultRoleIdsForPhase,
  invalidatePromptRegistryStore,
  normalizeRoleIds
} from "../orchestration/promptRegistryRepository.js";

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function buildDeleteMissingIdsQuery(tableName: string, ids: string[]) {
  if (ids.length === 0) {
    return { text: `delete from ${tableName}`, values: [] as unknown[] };
  }
  return {
    text: `delete from ${tableName} where not (id = any($1::text[]))`,
    values: [ids]
  };
}

function buildDeleteSessionScopedMissingIdsQuery(tableName: string, sessionId: string, ids: string[]) {
  if (ids.length === 0) {
    return { text: `delete from ${tableName} where session_id = $1`, values: [sessionId] as unknown[] };
  }
  return {
    text: `delete from ${tableName} where session_id = $1 and not (id = any($2::text[]))`,
    values: [sessionId, ids]
  };
}

function mapSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    problemStatement: String(row.problem_statement),
    roles: parseJson<string[]>(row.roles, []),
    context: parseJson<Record<string, unknown> | undefined>(row.context, undefined),
    state: String(row.state) as SessionRecord["state"],
    activeOutputSetIds: parseJson(row.active_output_set_ids, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapPhaseRunRow(row: Record<string, unknown>): PhaseRunRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    phase: String(row.phase) as PhaseRunRecord["phase"],
    status: String(row.status) as PhaseRunRecord["status"],
    attemptNumber: Number(row.attempt_number),
    triggerType: String(row.trigger_type) as PhaseRunRecord["triggerType"],
    triggeredByPhaseRunId: row.triggered_by_phase_run_id ? String(row.triggered_by_phase_run_id) : undefined,
    errorCode: row.error_code ? String(row.error_code) : undefined,
    errorCategory: row.error_category ? String(row.error_category) as PhaseRunRecord["errorCategory"] : undefined,
    retryCount: row.retry_count === null || row.retry_count === undefined ? undefined : Number(row.retry_count),
    diagnostics: parseJson<Record<string, unknown> | undefined>(row.diagnostics, undefined),
    promptTemplateVersion: row.prompt_template_version ? String(row.prompt_template_version) : undefined,
    roleConfigVersion: row.role_config_version ? String(row.role_config_version) : undefined,
    schemaVersion: row.schema_version ? String(row.schema_version) : undefined,
    promptVersionRefs: parseJson<PhaseRunRecord["promptVersionRefs"] | undefined>(row.prompt_version_refs, undefined),
    provider: row.provider ? String(row.provider) : undefined,
    model: row.model ? String(row.model) : undefined,
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined
  };
}

function mapOutputSetRow(row: Record<string, unknown>): OutputSetRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    phase: String(row.phase) as OutputSetRecord["phase"],
    runId: String(row.run_id),
    status: String(row.status) as OutputSetRecord["status"],
    supersedesOutputSetId: row.supersedes_output_set_id ? String(row.supersedes_output_set_id) : undefined,
    causedByEditId: row.caused_by_edit_id ? String(row.caused_by_edit_id) : undefined,
    createdAt: String(row.created_at)
  };
}

function mapGraphNodeRow(row: Record<string, unknown>): GraphNodeRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    phase: String(row.phase) as GraphNodeRecord["phase"],
    runId: String(row.run_id),
    outputSetId: String(row.output_set_id),
    nodeType: String(row.node_type) as GraphNodeRecord["nodeType"],
    status: String(row.status) as GraphNodeRecord["status"],
    content: parseJson<Record<string, unknown>>(row.content, {}),
    sourceRole: row.source_role ? String(row.source_role) : undefined,
    derivedFromNodeId: row.derived_from_node_id ? String(row.derived_from_node_id) : undefined,
    createdAt: String(row.created_at)
  };
}

function mapGraphEdgeRow(row: Record<string, unknown>): GraphEdgeRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    phase: String(row.phase) as GraphEdgeRecord["phase"],
    runId: String(row.run_id),
    outputSetId: String(row.output_set_id),
    edgeType: String(row.edge_type),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    status: String(row.status) as GraphEdgeRecord["status"],
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata, undefined)
  };
}

function mapExportRow(row: Record<string, unknown>): ExportRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    format: String(row.format) as ExportRecord["format"],
    status: String(row.status) as ExportRecord["status"],
    artifact: String(row.artifact),
    errorCode: row.error_code ? String(row.error_code) : undefined,
    retryCount: row.retry_count === null || row.retry_count === undefined ? undefined : Number(row.retry_count),
    createdAt: String(row.created_at)
  };
}

function mapModeratorEditRow(row: Record<string, unknown>): ModeratorEditRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    phase: String(row.phase) as ModeratorEditRecord["phase"],
    editedNodeId: row.edited_node_id ? String(row.edited_node_id) : undefined,
    editType: String(row.edit_type),
    before: parseJson<Record<string, unknown>>(row.before_payload, {}),
    after: parseJson<Record<string, unknown>>(row.after_payload, {}),
    createdAt: String(row.created_at)
  };
}

function normalizeProblemFramingContext(context?: Record<string, unknown>): ProblemFramingContext | undefined {
  const candidate = context?.problemFraming;
  if (!candidate || typeof candidate !== "object") return undefined;

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

function buildExportArtifact(session: SessionRecord, snapshot: GraphNodeRecord, format: "markdown" | "pdf") {
  if (format === "markdown" && String(snapshot.content.recommendation ?? "").includes("[[EXPORT_FAIL]]")) {
    throw new Error("export_render_failed");
  }

  return format === "markdown"
    ? `# ${session.title}\n\n## Problem\n${session.problemStatement}\n\n## Decision\n${String(snapshot.content.recommendation ?? "")}\n`
    : `<html><body><h1>${session.title}</h1><p>${String(snapshot.content.recommendation ?? "")}</p></body></html>`;
}

function seedStoreWithSessionDetails(store: InMemoryStore, details: SessionDetails) {
  store.sessions.set(details.session.id, details.session);
  details.phaseRuns.forEach((item) => store.phaseRuns.set(item.id, item));
  details.outputSets.forEach((item) => store.outputSets.set(item.id, item));
  details.nodes.forEach((item) => store.nodes.set(item.id, item));
  details.edges.forEach((item) => store.edges.set(item.id, item));
  details.exports.forEach((item) => store.exports.set(item.id, item));
  details.edits.forEach((item) => store.edits.set(item.id, item));
}

function reviewStateForPhase(phase: "diverge" | "cluster"): SessionRecord["state"] {
  return phase === "diverge" ? "diverge_review" : "cluster_review";
}

export class StorePersistence {
  private pool?: Pool;
  private initialized = false;

  constructor(private readonly store: InMemoryStore = new InMemoryStore()) {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (connectionString) {
      this.pool = new Pool({ connectionString });
    }
  }

  getStore() {
    return this.store;
  }

  isEnabled() {
    return Boolean(this.pool);
  }

  isReady() {
    return !this.pool || this.initialized;
  }

  async checkHealth() {
    if (!this.pool) {
      return { ok: true, persistence: "disabled" as const };
    }

    const client = await this.pool.connect();
    try {
      await client.query("select 1");
      return { ok: true, persistence: "enabled" as const };
    } finally {
      client.release();
    }
  }

  async initialize() {
    if (!this.pool || this.initialized) return;

    const client = await this.pool.connect();
    try {
      await client.query(`
        create table if not exists prompt_sets (
          id text primary key,
          type text not null,
          name text not null,
          title text not null,
          format text not null,
          current_version_id text,
          created_at text not null,
          updated_at text not null,
          unique (type, name)
        );
        create table if not exists prompt_drafts (
          prompt_set_id text primary key references prompt_sets(id) on delete cascade,
          content text not null,
          updated_at text not null
        );
        create table if not exists prompt_versions (
          id text primary key,
          prompt_set_id text not null references prompt_sets(id) on delete cascade,
          version_number integer not null,
          format text not null,
          content text not null,
          notes text,
          created_at text not null,
          published_at text not null,
          unique (prompt_set_id, version_number)
        );
        create table if not exists prompt_publish_events (
          id text primary key,
          prompt_set_id text not null references prompt_sets(id) on delete cascade,
          prompt_version_id text references prompt_versions(id) on delete set null,
          action text not null,
          notes text,
          created_at text not null
        );
        alter table phase_runs add column if not exists prompt_version_refs jsonb;
      `);
      await this.hydrate(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown persistence initialization failure";
      throw new Error(`Persistence schema is not ready. Run pnpm db:migrate. Original error: ${message}`);
    } finally {
      client.release();
    }
    this.initialized = true;
  }

  async reload() {
    if (!this.pool) return;
    const client = await this.pool.connect();
    try {
      await this.hydrate(client);
    } finally {
      client.release();
    }
  }

  async reset() {
    this.store.clear();
    invalidatePromptRegistryStore();
    if (!this.pool) return;

    const client = await this.pool.connect();
    try {
      await client.query(`
        truncate table
          prompt_publish_events,
          prompt_versions,
          prompt_drafts,
          prompt_sets,
          moderator_edits,
          exports,
          graph_edges,
          graph_nodes,
          output_sets,
          phase_runs,
          sessions
      `);
    } finally {
      client.release();
    }
  }

  async getSessionDetails(sessionId: string): Promise<SessionDetails | undefined> {
    if (!this.pool) {
      return this.store.getSessionDetails(sessionId);
    }

    const client = await this.pool.connect();
    try {
      return this.getSessionDetailsWithClient(client, sessionId);
    } finally {
      client.release();
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    if (!this.pool) {
      return this.store.listSessions();
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query("select id, title, problem_statement, state, created_at, updated_at from sessions order by updated_at desc");
      return result.rows.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        problemStatement: String(row.problem_statement),
        state: String(row.state) as SessionRecord["state"],
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      }));
    } finally {
      client.release();
    }
  }

  async createSession(input: {
    title?: string;
    problemStatement: string;
    roles?: string[];
    context?: Record<string, unknown>;
  }) {
    const session: SessionRecord = {
      id: makeId("session"),
      title: input.title ?? "Untitled session",
      problemStatement: input.problemStatement,
      roles: normalizeRoleIds(input.roles ?? getDefaultRoleIdsForPhase("diverge")),
      context: input.context,
      state: "draft",
      activeOutputSetIds: {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    if (!this.pool) {
      this.store.sessions.set(session.id, session);
      return session;
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      await client.query(
        `insert into sessions (
          id, title, problem_statement, roles, context, state, active_output_set_ids, created_at, updated_at
        ) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9)`,
        [
          session.id,
          session.title,
          session.problemStatement,
          JSON.stringify(session.roles),
          JSON.stringify(session.context ?? null),
          session.state,
          JSON.stringify(session.activeOutputSetIds),
          session.createdAt,
          session.updatedAt
        ]
      );
      await client.query("commit");
      this.store.sessions.set(session.id, session);
      telemetry.audit({
        id: makeId("audit"),
        eventType: "SessionCreated",
        sessionId: session.id,
        payload: { title: session.title, roleCount: session.roles.length },
        createdAt: nowIso()
      });
      return session;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async editProblemFraming(sessionId: string, patch: Partial<ProblemFramingContext>) {
    if (!this.pool) {
      const session = this.store.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");

      const currentFraming = normalizeProblemFramingContext(session.context);
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
      session.context = { ...(session.context ?? {}), problemFraming: nextFraming };
      session.problemStatement = nextFraming.clarifiedProblemStatement;
      session.updatedAt = nowIso();
      return this.store.getSessionDetails(sessionId)!;
    }

    const details = await this.getSessionDetails(sessionId);
    const session = details?.session;
    if (!session) throw new Error("Session not found");

    const currentFraming = normalizeProblemFramingContext(session.context);
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

    const editId = makeId("edit");
    const updatedAt = nowIso();
    const nextContext = { ...(session.context ?? {}), problemFraming: nextFraming };

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      await client.query(
        `insert into moderator_edits (
          id, session_id, phase, edited_node_id, edit_type, before_payload, after_payload, created_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [
          editId,
          sessionId,
          "diverge",
          null,
          "problem_framing_update",
          JSON.stringify({ problemFraming: currentFraming }),
          JSON.stringify({ problemFraming: nextFraming }),
          updatedAt
        ]
      );
      await client.query(
        `update sessions
         set context = $2::jsonb,
             problem_statement = $3,
             updated_at = $4
         where id = $1`,
        [sessionId, JSON.stringify(nextContext), nextFraming.clarifiedProblemStatement, updatedAt]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    await this.reload();
    return this.getSessionDetails(sessionId)!;
  }

  async approveDecision(
    sessionId: string,
    override?: { recommendation?: string; rationale?: string; risks?: string[]; nextSteps?: string[] }
  ) {
    if (!this.pool) {
      throw new Error("approveDecision repository path requires database persistence");
    }

    const details = await this.getSessionDetails(sessionId);
    const session = details?.session;
    if (!session || session.state !== "decision_review") throw new Error("Decision not ready");

    const activeDecision = details.outputSets.find((item) => item.phase === "decision" && item.status === "active");
    if (!activeDecision) throw new Error("Missing proposal");

    const proposal = details.nodes.find(
      (item) => item.outputSetId === activeDecision.id && item.nodeType === "decision_proposal" && item.status === "active"
    );
    if (!proposal) throw new Error("Missing proposal");

    const approvedOutputSetId = makeId("output");
    const snapshotId = makeId("snapshot");
    const timestamp = nowIso();
    const snapshotContent = { ...proposal.content, ...override };
    const nextActiveOutputSetIds = { ...session.activeOutputSetIds, decision: approvedOutputSetId };

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      await client.query(
        `update output_sets
         set status = 'superseded',
             supersedes_output_set_id = $2
         where session_id = $1 and phase = 'decision' and status = 'active'`,
        [sessionId, approvedOutputSetId]
      );
      await client.query(
        `update graph_nodes
         set status = 'superseded'
         where session_id = $1 and phase = 'decision' and output_set_id = $2 and status = 'active'`,
        [sessionId, activeDecision.id]
      );
      await client.query(
        `update graph_edges
         set status = 'superseded'
         where session_id = $1 and phase = 'decision' and output_set_id = $2 and status = 'active'`,
        [sessionId, activeDecision.id]
      );
      await client.query(
        `insert into output_sets (
          id, session_id, phase, run_id, status, supersedes_output_set_id, caused_by_edit_id, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [approvedOutputSetId, sessionId, "decision", proposal.runId, "active", null, null, timestamp]
      );
      await client.query(
        `insert into graph_nodes (
          id, session_id, phase, run_id, output_set_id, node_type, status, content, source_role, derived_from_node_id, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [
          snapshotId,
          sessionId,
          "decision",
          proposal.runId,
          approvedOutputSetId,
          "decision_snapshot",
          "active",
          JSON.stringify(snapshotContent),
          proposal.sourceRole ?? null,
          proposal.id,
          timestamp
        ]
      );
      await client.query(
        `update sessions
         set state = 'approved',
             active_output_set_ids = $2::jsonb,
             updated_at = $3
         where id = $1`,
        [sessionId, JSON.stringify(nextActiveOutputSetIds), timestamp]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    telemetry.increment("session_completion_total", { final_state: "approved" });
    telemetry.audit({
      id: makeId("audit"),
      eventType: "DecisionApproved",
      sessionId,
      phase: "decide",
      payload: { outputSetId: approvedOutputSetId },
      createdAt: nowIso()
    });

    await this.reload();
    return this.getSessionDetails(sessionId)!;
  }

  async editIdea(sessionId: string, ideaId: string, text: string) {
    if (!this.pool) {
      throw new Error("editIdea repository path requires database persistence");
    }

    const details = await this.getSessionDetails(sessionId);
    const session = details?.session;
    if (!session) throw new Error("Session not found");
    if (!["diverge_review", "cluster_review", "challenge_review", "decision_review"].includes(session.state)) {
      throw new Error("Edit not allowed in current state");
    }

    const node = details.nodes.find((item) => item.id === ideaId);
    if (!node || node.sessionId !== sessionId || node.phase !== "diverge") throw new Error("Idea not found");
    if (node.status !== "active" || node.outputSetId !== session.activeOutputSetIds.diverge) throw new Error("stale_write");

    const editId = makeId("edit");
    const revisedNodeId = makeId("idea");
    const timestamp = nowIso();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      await client.query(
        `insert into moderator_edits (
          id, session_id, phase, edited_node_id, edit_type, before_payload, after_payload, created_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [
          editId,
          sessionId,
          "diverge",
          ideaId,
          "idea_text_update",
          JSON.stringify(node.content),
          JSON.stringify({ ...node.content, text }),
          timestamp
        ]
      );
      await client.query(`update graph_nodes set status = 'superseded' where id = $1`, [ideaId]);
      await client.query(
        `insert into graph_nodes (
          id, session_id, phase, run_id, output_set_id, node_type, status, content, source_role, derived_from_node_id, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [
          revisedNodeId,
          sessionId,
          "diverge",
          node.runId,
          node.outputSetId,
          node.nodeType,
          "active",
          JSON.stringify({ ...node.content, text }),
          node.sourceRole ?? null,
          node.id,
          timestamp
        ]
      );
      await this.markDownstreamStaleInTransaction(client, sessionId, "diverge", editId);
      await client.query(`update sessions set state = $2, updated_at = $3 where id = $1`, [
        sessionId,
        reviewStateForPhase("diverge"),
        timestamp
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    await this.reload();
    return this.getSessionDetails(sessionId)!;
  }

  async editCluster(sessionId: string, clusterId: string, label: string) {
    if (!this.pool) {
      throw new Error("editCluster repository path requires database persistence");
    }

    const details = await this.getSessionDetails(sessionId);
    const session = details?.session;
    if (!session) throw new Error("Session not found");
    if (!["cluster_review", "challenge_review", "decision_review"].includes(session.state)) {
      throw new Error("Edit not allowed in current state");
    }

    const node = details.nodes.find((item) => item.id === clusterId);
    if (!node || node.sessionId !== sessionId || node.phase !== "cluster") throw new Error("Cluster not found");
    if (node.status !== "active" || node.outputSetId !== session.activeOutputSetIds.cluster) throw new Error("stale_write");

    const activeEdges = details.edges.filter((item) => item.toNodeId === clusterId && item.status === "active");
    const editId = makeId("edit");
    const revisedNodeId = makeId("cluster");
    const timestamp = nowIso();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      await client.query(
        `insert into moderator_edits (
          id, session_id, phase, edited_node_id, edit_type, before_payload, after_payload, created_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [
          editId,
          sessionId,
          "cluster",
          clusterId,
          "cluster_label_update",
          JSON.stringify(node.content),
          JSON.stringify({ ...node.content, label }),
          timestamp
        ]
      );
      await client.query(`update graph_nodes set status = 'superseded' where id = $1`, [clusterId]);
      await client.query(
        `insert into graph_nodes (
          id, session_id, phase, run_id, output_set_id, node_type, status, content, source_role, derived_from_node_id, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [
          revisedNodeId,
          sessionId,
          "cluster",
          node.runId,
          node.outputSetId,
          node.nodeType,
          "active",
          JSON.stringify({ ...node.content, label }),
          node.sourceRole ?? null,
          node.id,
          timestamp
        ]
      );
      for (const edge of activeEdges) {
        await client.query(`update graph_edges set status = 'superseded' where id = $1`, [edge.id]);
        await client.query(
          `insert into graph_edges (
            id, session_id, phase, run_id, output_set_id, edge_type, from_node_id, to_node_id, status, metadata
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [
            makeId("edge"),
            edge.sessionId,
            edge.phase,
            edge.runId,
            edge.outputSetId,
            edge.edgeType,
            edge.fromNodeId,
            revisedNodeId,
            "active",
            JSON.stringify(edge.metadata ?? null)
          ]
        );
      }
      await this.markDownstreamStaleInTransaction(client, sessionId, "cluster", editId);
      await client.query(`update sessions set state = $2, updated_at = $3 where id = $1`, [
        sessionId,
        reviewStateForPhase("cluster"),
        timestamp
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    await this.reload();
    return this.getSessionDetails(sessionId)!;
  }

  async mergeClusters(sessionId: string, clusterIds: string[], label: string) {
    if (!this.pool) {
      throw new Error("mergeClusters repository path requires database persistence");
    }

    const details = await this.getSessionDetails(sessionId);
    const session = details?.session;
    if (!session) throw new Error("Session not found");
    if (!["cluster_review", "challenge_review", "decision_review"].includes(session.state)) {
      throw new Error("Edit not allowed in current state");
    }
    if (clusterIds.length < 2) throw new Error("At least two clusters are required to merge");

    const activeOutputSetId = session.activeOutputSetIds.cluster;
    const clusters = clusterIds.map((clusterId) => details.nodes.find((item) => item.id === clusterId));
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

    const ideaIds = new Set<string>();
    for (const cluster of clusters as GraphNodeRecord[]) {
      const clusterIdeaIds = Array.isArray(cluster.content.ideaIds) ? cluster.content.ideaIds.map(String) : [];
      clusterIdeaIds.forEach((ideaId) => ideaIds.add(ideaId));
    }

    const affectedEdges = details.edges.filter((item) => clusterIds.includes(item.toNodeId) && item.status === "active");
    const mergedNodeId = makeId("cluster");
    const editId = makeId("edit");
    const timestamp = nowIso();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      await client.query(
        `insert into moderator_edits (
          id, session_id, phase, edited_node_id, edit_type, before_payload, after_payload, created_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [editId, sessionId, "cluster", null, "cluster_merge", JSON.stringify({ clusterIds }), JSON.stringify({ label }), timestamp]
      );
      await client.query(
        `update graph_nodes
         set status = 'superseded'
         where session_id = $1 and id = any($2::text[])`,
        [sessionId, clusterIds]
      );
      await client.query(
        `update graph_edges
         set status = 'superseded'
         where session_id = $1 and to_node_id = any($2::text[]) and status = 'active'`,
        [sessionId, clusterIds]
      );
      await client.query(
        `insert into graph_nodes (
          id, session_id, phase, run_id, output_set_id, node_type, status, content, source_role, derived_from_node_id, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [
          mergedNodeId,
          sessionId,
          "cluster",
          (clusters[0] as GraphNodeRecord).runId,
          activeOutputSetId,
          "cluster",
          "active",
          JSON.stringify({ label, confidence: 1, ideaIds: [...ideaIds] }),
          null,
          null,
          timestamp
        ]
      );
      for (const ideaId of ideaIds) {
        await client.query(
          `insert into graph_edges (
            id, session_id, phase, run_id, output_set_id, edge_type, from_node_id, to_node_id, status, metadata
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [
            makeId("edge"),
            sessionId,
            "cluster",
            (clusters[0] as GraphNodeRecord).runId,
            activeOutputSetId,
            "belongs_to_cluster",
            ideaId,
            mergedNodeId,
            "active",
            JSON.stringify(null)
          ]
        );
      }
      await this.markDownstreamStaleInTransaction(client, sessionId, "cluster", editId);
      await client.query(`update sessions set state = $2, updated_at = $3 where id = $1`, [
        sessionId,
        reviewStateForPhase("cluster"),
        timestamp
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    void affectedEdges;
    await this.reload();
    return this.getSessionDetails(sessionId)!;
  }

  async splitCluster(sessionId: string, clusterId: string, splits: { label: string; ideaIds: string[] }[]) {
    if (!this.pool) {
      throw new Error("splitCluster repository path requires database persistence");
    }

    const details = await this.getSessionDetails(sessionId);
    const session = details?.session;
    if (!session) throw new Error("Session not found");
    if (!["cluster_review", "challenge_review", "decision_review"].includes(session.state)) {
      throw new Error("Edit not allowed in current state");
    }

    const cluster = details.nodes.find((item) => item.id === clusterId);
    if (!cluster || cluster.sessionId !== sessionId || cluster.phase !== "cluster" || cluster.nodeType !== "cluster") {
      throw new Error("Cluster not found");
    }
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

    const editId = makeId("edit");
    const timestamp = nowIso();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      await client.query(
        `insert into moderator_edits (
          id, session_id, phase, edited_node_id, edit_type, before_payload, after_payload, created_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [
          editId,
          sessionId,
          "cluster",
          clusterId,
          "cluster_split",
          JSON.stringify({ ideaIds: originalIdeaIds, label: cluster.content.label }),
          JSON.stringify({ splits }),
          timestamp
        ]
      );
      await client.query(`update graph_nodes set status = 'superseded' where id = $1`, [clusterId]);
      await client.query(
        `update graph_edges
         set status = 'superseded'
         where session_id = $1 and to_node_id = $2 and status = 'active'`,
        [sessionId, clusterId]
      );
      for (const split of splits) {
        const nextClusterId = makeId("cluster");
        await client.query(
          `insert into graph_nodes (
            id, session_id, phase, run_id, output_set_id, node_type, status, content, source_role, derived_from_node_id, created_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
          [
            nextClusterId,
            sessionId,
            "cluster",
            cluster.runId,
            cluster.outputSetId,
            "cluster",
            "active",
            JSON.stringify({ label: split.label, confidence: 1, ideaIds: split.ideaIds }),
            null,
            cluster.id,
            timestamp
          ]
        );
        for (const ideaId of split.ideaIds) {
          await client.query(
            `insert into graph_edges (
              id, session_id, phase, run_id, output_set_id, edge_type, from_node_id, to_node_id, status, metadata
            ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
            [
              makeId("edge"),
              sessionId,
              "cluster",
              cluster.runId,
              cluster.outputSetId,
              "belongs_to_cluster",
              ideaId,
              nextClusterId,
              "active",
              JSON.stringify(null)
            ]
          );
        }
      }
      await this.markDownstreamStaleInTransaction(client, sessionId, "cluster", editId);
      await client.query(`update sessions set state = $2, updated_at = $3 where id = $1`, [
        sessionId,
        reviewStateForPhase("cluster"),
        timestamp
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    await this.reload();
    return this.getSessionDetails(sessionId)!;
  }

  async startPhase(
    sessionId: string,
    phase: PhaseRunRecord["phase"],
    triggerType: PhaseRunRecord["triggerType"] = "initial",
    serviceTemplate?: SessionService
  ) {
    if (!this.pool) {
      throw new Error("startPhase repository path requires database persistence");
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      const details = await this.getSessionDetailsWithClient(client, sessionId);
      if (!details) throw new Error("Session not found");

      const workingStore = new InMemoryStore();
      seedStoreWithSessionDetails(workingStore, details);
      const workingService = new SessionService(workingStore);
      const templateProvider = (serviceTemplate as unknown as { llmProvider?: unknown } | undefined)?.llmProvider;
      if (templateProvider) {
        (workingService as unknown as { llmProvider?: unknown }).llmProvider = templateProvider;
      }
      const result = await workingService.startPhase(sessionId, phase, triggerType);

      await this.persistSessionAggregate(client, workingStore, sessionId);
      await client.query("commit");

      this.store.clear();
      seedStoreWithSessionDetails(this.store, result);
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async rerunPhase(sessionId: string, phase: PhaseRunRecord["phase"], serviceTemplate?: SessionService) {
    return this.startPhase(sessionId, phase, "rerun", serviceTemplate);
  }

  async editDecisionSummary(
    sessionId: string,
    patch: { recommendation?: string; rationale?: string; risks?: string[]; nextSteps?: string[] }
  ) {
    if (!this.pool) {
      throw new Error("editDecisionSummary repository path requires database persistence");
    }

    const details = await this.getSessionDetails(sessionId);
    const session = details?.session;
    if (!session || session.state !== "decision_review") throw new Error("Decision not ready");

    const activeDecision = details.outputSets.find((item) => item.phase === "decision" && item.status === "active");
    if (!activeDecision) throw new Error("Missing proposal");

    const proposal = details.nodes.find(
      (item) => item.outputSetId === activeDecision.id && item.nodeType === "decision_proposal" && item.status === "active"
    );
    if (!proposal) throw new Error("Missing proposal");

    const nextContent = {
      ...proposal.content,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
    };

    const editId = makeId("edit");
    const revisedNodeId = makeId("decision");
    const timestamp = nowIso();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      await client.query(
        `insert into moderator_edits (
          id, session_id, phase, edited_node_id, edit_type, before_payload, after_payload, created_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [
          editId,
          sessionId,
          "decision",
          proposal.id,
          "decision_summary_update",
          JSON.stringify(proposal.content),
          JSON.stringify(nextContent),
          timestamp
        ]
      );
      await client.query(`update graph_nodes set status = 'superseded' where id = $1`, [proposal.id]);
      await client.query(
        `insert into graph_nodes (
          id, session_id, phase, run_id, output_set_id, node_type, status, content, source_role, derived_from_node_id, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [
          revisedNodeId,
          sessionId,
          "decision",
          proposal.runId,
          proposal.outputSetId,
          "decision_proposal",
          "active",
          JSON.stringify(nextContent),
          proposal.sourceRole ?? null,
          proposal.id,
          timestamp
        ]
      );
      await client.query(`update sessions set updated_at = $2 where id = $1`, [sessionId, timestamp]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    await this.reload();
    return this.getSessionDetails(sessionId)!;
  }

  async rejectDecision(sessionId: string, returnTarget: "challenge_review" | "cluster_review" | "diverge_review") {
    if (!this.pool) {
      throw new Error("rejectDecision repository path requires database persistence");
    }

    const details = await this.getSessionDetails(sessionId);
    const session = details?.session;
    if (!session || session.state !== "decision_review") throw new Error("Decision not ready");

    const activeDecision = details.outputSets.find((item) => item.phase === "decision" && item.status === "active");
    const timestamp = nowIso();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      if (activeDecision) {
        await client.query(`update output_sets set status = 'rejected' where id = $1`, [activeDecision.id]);
        await client.query(
          `update graph_nodes
           set status = 'rejected'
           where session_id = $1 and phase = 'decision' and output_set_id = $2 and status = 'active'`,
          [sessionId, activeDecision.id]
        );
        await client.query(
          `update graph_edges
           set status = 'rejected'
           where session_id = $1 and phase = 'decision' and output_set_id = $2 and status = 'active'`,
          [sessionId, activeDecision.id]
        );
      }
      await client.query(`update sessions set state = $2, updated_at = $3 where id = $1`, [sessionId, returnTarget, timestamp]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    telemetry.increment("decision_rejection_total", { return_target: returnTarget });
    telemetry.audit({
      id: makeId("audit"),
      eventType: "DecisionRejected",
      sessionId,
      phase: "decide",
      payload: { returnTarget },
      createdAt: nowIso()
    });

    await this.reload();
    return this.getSessionDetails(sessionId)!;
  }

  async exportSession(sessionId: string, format: "markdown" | "pdf" = "markdown") {
    if (!this.pool) {
      throw new Error("exportSession repository path requires database persistence");
    }

    const details = await this.getSessionDetails(sessionId);
    const session = details?.session;
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

    const decisionSet = details.outputSets.find((item) => item.phase === "decision" && item.status === "active");
    const snapshot = decisionSet
      ? details.nodes.find(
          (item) => item.outputSetId === decisionSet.id && item.nodeType === "decision_snapshot" && item.status === "active"
        )
      : undefined;

    const exportId = makeId("export");
    const timestamp = nowIso();

    if (!snapshot) {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock($1)", [48151623]);
        await client.query(
          `insert into exports (
            id, session_id, format, status, artifact, error_code, retry_count, created_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [exportId, sessionId, format, "failed", "", "missing_approved_snapshot", 0, timestamp]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      telemetry.increment("export_total", { format, status: "failure" });
      telemetry.audit({
        id: makeId("audit"),
        eventType: "ExportFailed",
        sessionId,
        payload: { format, errorCode: "missing_approved_snapshot" },
        createdAt: nowIso()
      });
      await this.reload();
      throw new Error("Missing approved snapshot");
    }

    try {
      const artifact = buildExportArtifact(session, snapshot, format);
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock($1)", [48151623]);
        await client.query(
          `insert into exports (
            id, session_id, format, status, artifact, error_code, retry_count, created_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [exportId, sessionId, format, "completed", artifact, null, 0, timestamp]
        );
        await client.query(`update sessions set state = 'exported', updated_at = $2 where id = $1`, [sessionId, timestamp]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      telemetry.increment("export_total", { format, status: "success" });
      telemetry.increment("session_completion_total", { final_state: "exported" });
      telemetry.audit({
        id: makeId("audit"),
        eventType: "ExportCompleted",
        sessionId,
        payload: { format, exportId },
        createdAt: nowIso()
      });
      await this.reload();
      return this.store.exports.get(exportId)!;
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : "export_render_failed";
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock($1)", [48151623]);
        await client.query(
          `insert into exports (
            id, session_id, format, status, artifact, error_code, retry_count, created_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [exportId, sessionId, format, "failed", "", errorCode, 0, timestamp]
        );
        await client.query(`update sessions set state = 'approved', updated_at = $2 where id = $1`, [sessionId, timestamp]);
        await client.query("commit");
      } catch (commitError) {
        await client.query("rollback");
        throw commitError;
      } finally {
        client.release();
      }

      telemetry.increment("export_total", { format, status: "failure" });
      telemetry.audit({
        id: makeId("audit"),
        eventType: "ExportFailed",
        sessionId,
        payload: { format, errorCode },
        createdAt: nowIso()
      });
      await this.reload();
      throw error;
    }
  }

  async runSerializedMutation<T>(operation: () => T | Promise<T>) {
    if (!this.pool) {
      return operation();
    }

    const client = await this.pool.connect();

    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [48151623]);
      await this.hydrate(client);
      const result = await operation();
      await this.persistSnapshot(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async hydrate(client: PoolClient) {
    if (!this.pool) return;

    this.store.clear();

    const sessions = await client.query("select * from sessions");
    const phaseRuns = await client.query("select * from phase_runs");
    const outputSets = await client.query("select * from output_sets");
    const nodes = await client.query("select * from graph_nodes");
    const edges = await client.query("select * from graph_edges");
    const exportsList = await client.query("select * from exports");
    const edits = await client.query("select * from moderator_edits");

    for (const row of sessions.rows) {
      this.store.sessions.set(row.id, mapSessionRow(row));
    }

    for (const row of phaseRuns.rows) {
      this.store.phaseRuns.set(row.id, mapPhaseRunRow(row));
    }

    for (const row of outputSets.rows) {
      this.store.outputSets.set(row.id, mapOutputSetRow(row));
    }

    for (const row of nodes.rows) {
      this.store.nodes.set(row.id, mapGraphNodeRow(row));
    }

    for (const row of edges.rows) {
      this.store.edges.set(row.id, mapGraphEdgeRow(row));
    }

    for (const row of exportsList.rows) {
      this.store.exports.set(row.id, mapExportRow(row));
    }

    for (const row of edits.rows) {
      this.store.edits.set(row.id, mapModeratorEditRow(row));
    }
  }

  private async markDownstreamStaleInTransaction(
    client: PoolClient,
    sessionId: string,
    phase: "diverge" | "cluster",
    causedByEditId: string
  ) {
    const downstream = phase === "diverge" ? ["cluster", "challenge", "decision"] : ["challenge", "decision"];
    await client.query(
      `update output_sets
       set status = 'stale',
           caused_by_edit_id = $3
       where session_id = $1 and phase = any($2::text[]) and status = 'active'`,
      [sessionId, downstream, causedByEditId]
    );
    await client.query(
      `update graph_nodes
       set status = 'stale'
       where session_id = $1 and phase = any($2::text[]) and status = 'active'`,
      [sessionId, downstream]
    );
    await client.query(
      `update graph_edges
       set status = 'stale'
       where session_id = $1 and phase = any($2::text[]) and status = 'active'`,
      [sessionId, downstream]
    );
    telemetry.increment("stale_output_set_total", { phase: phase === "diverge" ? "cluster" : "challenge" });
    telemetry.audit({
      id: makeId("audit"),
      eventType: "PhaseOutputsMarkedStale",
      sessionId,
      phase,
      payload: { causedByEditId },
      createdAt: nowIso()
    });
  }

  private async getSessionDetailsWithClient(client: PoolClient, sessionId: string): Promise<SessionDetails | undefined> {
    const sessionResult = await client.query("select * from sessions where id = $1", [sessionId]);
    const sessionRow = sessionResult.rows[0];
    if (!sessionRow) return undefined;

    const phaseRuns = await client.query("select * from phase_runs where session_id = $1 order by started_at asc", [sessionId]);
    const outputSets = await client.query("select * from output_sets where session_id = $1 order by created_at asc", [sessionId]);
    const nodes = await client.query("select * from graph_nodes where session_id = $1 order by created_at asc", [sessionId]);
    const edges = await client.query("select * from graph_edges where session_id = $1", [sessionId]);
    const exportsList = await client.query("select * from exports where session_id = $1 order by created_at asc", [sessionId]);
    const edits = await client.query("select * from moderator_edits where session_id = $1 order by created_at asc", [sessionId]);

    return {
      session: mapSessionRow(sessionRow),
      phaseRuns: phaseRuns.rows.map((row) => mapPhaseRunRow(row)),
      outputSets: outputSets.rows.map((row) => mapOutputSetRow(row)),
      nodes: nodes.rows.map((row) => mapGraphNodeRow(row)),
      edges: edges.rows.map((row) => mapGraphEdgeRow(row)),
      exports: exportsList.rows.map((row) => mapExportRow(row)),
      edits: edits.rows.map((row) => mapModeratorEditRow(row))
    };
  }

  private async persistSessionAggregate(client: PoolClient, store: InMemoryStore, sessionId: string) {
    const details = store.getSessionDetails(sessionId);
    if (!details) {
      throw new Error("Session not found");
    }

    const session = details.session;
    await client.query(
      `insert into sessions (
        id, title, problem_statement, roles, context, state, active_output_set_ids, created_at, updated_at
      ) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9)
      on conflict (id) do update set
        title = excluded.title,
        problem_statement = excluded.problem_statement,
        roles = excluded.roles,
        context = excluded.context,
        state = excluded.state,
        active_output_set_ids = excluded.active_output_set_ids,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      [
        session.id,
        session.title,
        session.problemStatement,
        JSON.stringify(session.roles),
        JSON.stringify(session.context ?? null),
        session.state,
        JSON.stringify(session.activeOutputSetIds),
        session.createdAt,
        session.updatedAt
      ]
    );

    for (const run of details.phaseRuns) {
      await client.query(
        `insert into phase_runs (
          id, session_id, phase, status, attempt_number, trigger_type, triggered_by_phase_run_id,
          error_code, error_category, retry_count, diagnostics, prompt_template_version,
          role_config_version, schema_version, prompt_version_refs, provider, model, started_at, completed_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16,$17,$18,$19)
        on conflict (id) do update set
          session_id = excluded.session_id,
          phase = excluded.phase,
          status = excluded.status,
          attempt_number = excluded.attempt_number,
          trigger_type = excluded.trigger_type,
          triggered_by_phase_run_id = excluded.triggered_by_phase_run_id,
          error_code = excluded.error_code,
          error_category = excluded.error_category,
          retry_count = excluded.retry_count,
          diagnostics = excluded.diagnostics,
          prompt_template_version = excluded.prompt_template_version,
          role_config_version = excluded.role_config_version,
          schema_version = excluded.schema_version,
          prompt_version_refs = excluded.prompt_version_refs,
          provider = excluded.provider,
          model = excluded.model,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at`,
        [
          run.id,
          run.sessionId,
          run.phase,
          run.status,
          run.attemptNumber,
          run.triggerType,
          run.triggeredByPhaseRunId ?? null,
          run.errorCode ?? null,
          run.errorCategory ?? null,
          run.retryCount ?? null,
          JSON.stringify(run.diagnostics ?? null),
          run.promptTemplateVersion ?? null,
          run.roleConfigVersion ?? null,
          run.schemaVersion ?? null,
          JSON.stringify(run.promptVersionRefs ?? null),
          run.provider ?? null,
          run.model ?? null,
          run.startedAt,
          run.completedAt ?? null
        ]
      );
    }
    await client.query(buildDeleteSessionScopedMissingIdsQuery("phase_runs", sessionId, details.phaseRuns.map((item) => item.id)));

    for (const output of details.outputSets) {
      await client.query(
        `insert into output_sets (
          id, session_id, phase, run_id, status, supersedes_output_set_id, caused_by_edit_id, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (id) do update set
          session_id = excluded.session_id,
          phase = excluded.phase,
          run_id = excluded.run_id,
          status = excluded.status,
          supersedes_output_set_id = excluded.supersedes_output_set_id,
          caused_by_edit_id = excluded.caused_by_edit_id,
          created_at = excluded.created_at`,
        [
          output.id,
          output.sessionId,
          output.phase,
          output.runId,
          output.status,
          output.supersedesOutputSetId ?? null,
          output.causedByEditId ?? null,
          output.createdAt
        ]
      );
    }
    await client.query(
      buildDeleteSessionScopedMissingIdsQuery("output_sets", sessionId, details.outputSets.map((item) => item.id))
    );

    for (const node of details.nodes) {
      await client.query(
        `insert into graph_nodes (
          id, session_id, phase, run_id, output_set_id, node_type, status, content, source_role, derived_from_node_id, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
        on conflict (id) do update set
          session_id = excluded.session_id,
          phase = excluded.phase,
          run_id = excluded.run_id,
          output_set_id = excluded.output_set_id,
          node_type = excluded.node_type,
          status = excluded.status,
          content = excluded.content,
          source_role = excluded.source_role,
          derived_from_node_id = excluded.derived_from_node_id,
          created_at = excluded.created_at`,
        [
          node.id,
          node.sessionId,
          node.phase,
          node.runId,
          node.outputSetId,
          node.nodeType,
          node.status,
          JSON.stringify(node.content),
          node.sourceRole ?? null,
          node.derivedFromNodeId ?? null,
          node.createdAt
        ]
      );
    }
    await client.query(buildDeleteSessionScopedMissingIdsQuery("graph_nodes", sessionId, details.nodes.map((item) => item.id)));

    for (const edge of details.edges) {
      await client.query(
        `insert into graph_edges (
          id, session_id, phase, run_id, output_set_id, edge_type, from_node_id, to_node_id, status, metadata
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        on conflict (id) do update set
          session_id = excluded.session_id,
          phase = excluded.phase,
          run_id = excluded.run_id,
          output_set_id = excluded.output_set_id,
          edge_type = excluded.edge_type,
          from_node_id = excluded.from_node_id,
          to_node_id = excluded.to_node_id,
          status = excluded.status,
          metadata = excluded.metadata`,
        [
          edge.id,
          edge.sessionId,
          edge.phase,
          edge.runId,
          edge.outputSetId,
          edge.edgeType,
          edge.fromNodeId,
          edge.toNodeId,
          edge.status,
          JSON.stringify(edge.metadata ?? null)
        ]
      );
    }
    await client.query(buildDeleteSessionScopedMissingIdsQuery("graph_edges", sessionId, details.edges.map((item) => item.id)));

    for (const exportRecord of details.exports) {
      await client.query(
        `insert into exports (
          id, session_id, format, status, artifact, error_code, retry_count, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (id) do update set
          session_id = excluded.session_id,
          format = excluded.format,
          status = excluded.status,
          artifact = excluded.artifact,
          error_code = excluded.error_code,
          retry_count = excluded.retry_count,
          created_at = excluded.created_at`,
        [
          exportRecord.id,
          exportRecord.sessionId,
          exportRecord.format,
          exportRecord.status,
          exportRecord.artifact,
          exportRecord.errorCode ?? null,
          exportRecord.retryCount ?? null,
          exportRecord.createdAt
        ]
      );
    }
    await client.query(buildDeleteSessionScopedMissingIdsQuery("exports", sessionId, details.exports.map((item) => item.id)));

    for (const edit of details.edits) {
      await client.query(
        `insert into moderator_edits (
          id, session_id, phase, edited_node_id, edit_type, before_payload, after_payload, created_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
        on conflict (id) do update set
          session_id = excluded.session_id,
          phase = excluded.phase,
          edited_node_id = excluded.edited_node_id,
          edit_type = excluded.edit_type,
          before_payload = excluded.before_payload,
          after_payload = excluded.after_payload,
          created_at = excluded.created_at`,
        [
          edit.id,
          edit.sessionId,
          edit.phase,
          edit.editedNodeId ?? null,
          edit.editType,
          JSON.stringify(edit.before),
          JSON.stringify(edit.after),
          edit.createdAt
        ]
      );
    }
    await client.query(
      buildDeleteSessionScopedMissingIdsQuery("moderator_edits", sessionId, details.edits.map((item) => item.id))
    );
  }

  private async persistSnapshot(client: PoolClient) {
    if (!this.pool) return;
    const sessions = [...this.store.sessions.values()];
    const phaseRuns = [...this.store.phaseRuns.values()];
    const outputSets = [...this.store.outputSets.values()];
    const nodes = [...this.store.nodes.values()];
    const edges = [...this.store.edges.values()];
    const exportsList = [...this.store.exports.values()];
    const edits = [...this.store.edits.values()];

    for (const session of sessions) {
      await client.query(
        `insert into sessions (
          id, title, problem_statement, roles, context, state, active_output_set_ids, created_at, updated_at
        ) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9)
        on conflict (id) do update set
          title = excluded.title,
          problem_statement = excluded.problem_statement,
          roles = excluded.roles,
          context = excluded.context,
          state = excluded.state,
          active_output_set_ids = excluded.active_output_set_ids,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at`,
        [
          session.id,
          session.title,
          session.problemStatement,
          JSON.stringify(session.roles),
          JSON.stringify(session.context ?? null),
          session.state,
          JSON.stringify(session.activeOutputSetIds),
          session.createdAt,
          session.updatedAt
        ]
      );
    }
    await client.query(buildDeleteMissingIdsQuery("sessions", sessions.map((item) => item.id)));

    for (const run of phaseRuns) {
      await client.query(
        `insert into phase_runs (
          id, session_id, phase, status, attempt_number, trigger_type, triggered_by_phase_run_id,
          error_code, error_category, retry_count, diagnostics, prompt_template_version,
          role_config_version, schema_version, prompt_version_refs, provider, model, started_at, completed_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16,$17,$18,$19)
        on conflict (id) do update set
          session_id = excluded.session_id,
          phase = excluded.phase,
          status = excluded.status,
          attempt_number = excluded.attempt_number,
          trigger_type = excluded.trigger_type,
          triggered_by_phase_run_id = excluded.triggered_by_phase_run_id,
          error_code = excluded.error_code,
          error_category = excluded.error_category,
          retry_count = excluded.retry_count,
          diagnostics = excluded.diagnostics,
          prompt_template_version = excluded.prompt_template_version,
          role_config_version = excluded.role_config_version,
          schema_version = excluded.schema_version,
          prompt_version_refs = excluded.prompt_version_refs,
          provider = excluded.provider,
          model = excluded.model,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at`,
        [
          run.id,
          run.sessionId,
          run.phase,
          run.status,
          run.attemptNumber,
          run.triggerType,
          run.triggeredByPhaseRunId ?? null,
          run.errorCode ?? null,
          run.errorCategory ?? null,
          run.retryCount ?? null,
          JSON.stringify(run.diagnostics ?? null),
          run.promptTemplateVersion ?? null,
          run.roleConfigVersion ?? null,
          run.schemaVersion ?? null,
          JSON.stringify(run.promptVersionRefs ?? null),
          run.provider ?? null,
          run.model ?? null,
          run.startedAt,
          run.completedAt ?? null
        ]
      );
    }
    await client.query(buildDeleteMissingIdsQuery("phase_runs", phaseRuns.map((item) => item.id)));

    for (const output of outputSets) {
      await client.query(
        `insert into output_sets (
          id, session_id, phase, run_id, status, supersedes_output_set_id, caused_by_edit_id, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (id) do update set
          session_id = excluded.session_id,
          phase = excluded.phase,
          run_id = excluded.run_id,
          status = excluded.status,
          supersedes_output_set_id = excluded.supersedes_output_set_id,
          caused_by_edit_id = excluded.caused_by_edit_id,
          created_at = excluded.created_at`,
        [
          output.id,
          output.sessionId,
          output.phase,
          output.runId,
          output.status,
          output.supersedesOutputSetId ?? null,
          output.causedByEditId ?? null,
          output.createdAt
        ]
      );
    }
    await client.query(buildDeleteMissingIdsQuery("output_sets", outputSets.map((item) => item.id)));

    for (const node of nodes) {
      await client.query(
        `insert into graph_nodes (
          id, session_id, phase, run_id, output_set_id, node_type, status, content, source_role, derived_from_node_id, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
        on conflict (id) do update set
          session_id = excluded.session_id,
          phase = excluded.phase,
          run_id = excluded.run_id,
          output_set_id = excluded.output_set_id,
          node_type = excluded.node_type,
          status = excluded.status,
          content = excluded.content,
          source_role = excluded.source_role,
          derived_from_node_id = excluded.derived_from_node_id,
          created_at = excluded.created_at`,
        [
          node.id,
          node.sessionId,
          node.phase,
          node.runId,
          node.outputSetId,
          node.nodeType,
          node.status,
          JSON.stringify(node.content),
          node.sourceRole ?? null,
          node.derivedFromNodeId ?? null,
          node.createdAt
        ]
      );
    }
    await client.query(buildDeleteMissingIdsQuery("graph_nodes", nodes.map((item) => item.id)));

    for (const edge of edges) {
      await client.query(
        `insert into graph_edges (
          id, session_id, phase, run_id, output_set_id, edge_type, from_node_id, to_node_id, status, metadata
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        on conflict (id) do update set
          session_id = excluded.session_id,
          phase = excluded.phase,
          run_id = excluded.run_id,
          output_set_id = excluded.output_set_id,
          edge_type = excluded.edge_type,
          from_node_id = excluded.from_node_id,
          to_node_id = excluded.to_node_id,
          status = excluded.status,
          metadata = excluded.metadata`,
        [
          edge.id,
          edge.sessionId,
          edge.phase,
          edge.runId,
          edge.outputSetId,
          edge.edgeType,
          edge.fromNodeId,
          edge.toNodeId,
          edge.status,
          JSON.stringify(edge.metadata ?? null)
        ]
      );
    }
    await client.query(buildDeleteMissingIdsQuery("graph_edges", edges.map((item) => item.id)));

    for (const exportRecord of exportsList) {
      await client.query(
        `insert into exports (
          id, session_id, format, status, artifact, error_code, retry_count, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (id) do update set
          session_id = excluded.session_id,
          format = excluded.format,
          status = excluded.status,
          artifact = excluded.artifact,
          error_code = excluded.error_code,
          retry_count = excluded.retry_count,
          created_at = excluded.created_at`,
        [
          exportRecord.id,
          exportRecord.sessionId,
          exportRecord.format,
          exportRecord.status,
          exportRecord.artifact,
          exportRecord.errorCode ?? null,
          exportRecord.retryCount ?? null,
          exportRecord.createdAt
        ]
      );
    }
    await client.query(buildDeleteMissingIdsQuery("exports", exportsList.map((item) => item.id)));

    for (const edit of edits) {
      await client.query(
        `insert into moderator_edits (
          id, session_id, phase, edited_node_id, edit_type, before_payload, after_payload, created_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
        on conflict (id) do update set
          session_id = excluded.session_id,
          phase = excluded.phase,
          edited_node_id = excluded.edited_node_id,
          edit_type = excluded.edit_type,
          before_payload = excluded.before_payload,
          after_payload = excluded.after_payload,
          created_at = excluded.created_at`,
        [
          edit.id,
          edit.sessionId,
          edit.phase,
          edit.editedNodeId ?? null,
          edit.editType,
          JSON.stringify(edit.before),
          JSON.stringify(edit.after),
          edit.createdAt
        ]
      );
    }
    await client.query(buildDeleteMissingIdsQuery("moderator_edits", edits.map((item) => item.id)));
  }
}

export function createStorePersistence(store: InMemoryStore = new InMemoryStore()) {
  return new StorePersistence(store);
}
