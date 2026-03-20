import type {
  ExportRecord,
  GraphEdgeRecord,
  GraphNodeRecord,
  ModeratorEditRecord,
  OutputSetRecord,
  Phase,
  PhaseRunRecord,
  SessionDetails,
  SessionRecord,
  SessionSummary
} from "../../shared/types.js";

export class InMemoryStore {
  sessions = new Map<string, SessionRecord>();
  phaseRuns = new Map<string, PhaseRunRecord>();
  outputSets = new Map<string, OutputSetRecord>();
  nodes = new Map<string, GraphNodeRecord>();
  edges = new Map<string, GraphEdgeRecord>();
  exports = new Map<string, ExportRecord>();
  edits = new Map<string, ModeratorEditRecord>();

  clear() {
    this.sessions.clear();
    this.phaseRuns.clear();
    this.outputSets.clear();
    this.nodes.clear();
    this.edges.clear();
    this.exports.clear();
    this.edits.clear();
  }

  getSessionDetails(sessionId: string): SessionDetails | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return {
      session,
      phaseRuns: [...this.phaseRuns.values()].filter((item) => item.sessionId === sessionId),
      outputSets: [...this.outputSets.values()].filter((item) => item.sessionId === sessionId),
      nodes: [...this.nodes.values()].filter((item) => item.sessionId === sessionId),
      edges: [...this.edges.values()].filter((item) => item.sessionId === sessionId),
      exports: [...this.exports.values()].filter((item) => item.sessionId === sessionId),
      edits: [...this.edits.values()].filter((item) => item.sessionId === sessionId)
    };
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      .map((session) => ({
        id: session.id,
        title: session.title,
        problemStatement: session.problemStatement,
        state: session.state,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }));
  }

  getActiveOutputSet(sessionId: string, phase: Phase | "decision") {
    return [...this.outputSets.values()].find(
      (item) => item.sessionId === sessionId && item.phase === phase && item.status === "active"
    );
  }
}

export const store = new InMemoryStore();

export function clearStore(target: InMemoryStore) {
  target.clear();
}
