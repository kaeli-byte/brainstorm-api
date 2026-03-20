export const phases = ["diverge", "cluster", "challenge", "decide"] as const;
export type Phase = (typeof phases)[number];

export const sessionStates = [
  "draft",
  "diverge_running",
  "diverge_review",
  "diverge_failed",
  "cluster_running",
  "cluster_review",
  "cluster_failed",
  "challenge_running",
  "challenge_review",
  "challenge_failed",
  "decide_running",
  "decision_review",
  "decide_failed",
  "approved",
  "export_running",
  "export_failed",
  "exported",
  "cancelled"
] as const;

export type SessionState = (typeof sessionStates)[number];

export type OutputStatus = "active" | "superseded" | "stale" | "rejected" | "failed";
export type PhaseRunStatus = "running" | "completed" | "failed";
export type TriggerType = "initial" | "rerun" | "downstream_rerun";
export type PromptSetType = "manifest" | "phase_prompt" | "role_prompt" | "schema" | "tool_prompt";
export type ErrorCategory =
  | "provider_timeout"
  | "provider_rate_limit"
  | "provider_transport"
  | "schema_validation"
  | "clustering_error"
  | "export_error"
  | "concurrency_conflict"
  | "state_guard"
  | "unknown_error";
export type NodeType =
  | "idea"
  | "cluster"
  | "critique"
  | "decision_proposal"
  | "decision_snapshot";

export interface SessionRecord {
  id: string;
  title: string;
  problemStatement: string;
  roles: string[];
  context?: Record<string, unknown>;
  state: SessionState;
  activeOutputSetIds: Partial<Record<Phase | "decision", string>>;
  createdAt: string;
  updatedAt: string;
}

export interface PhaseRunRecord {
  id: string;
  sessionId: string;
  phase: Phase;
  status: PhaseRunStatus;
  attemptNumber: number;
  triggerType: TriggerType;
  triggeredByPhaseRunId?: string;
  errorCode?: string;
  errorCategory?: ErrorCategory;
  retryCount?: number;
  diagnostics?: Record<string, unknown>;
  promptTemplateVersion?: string;
  roleConfigVersion?: string;
  schemaVersion?: string;
  promptVersionRefs?: PromptVersionReference;
  provider?: string;
  model?: string;
  startedAt: string;
  completedAt?: string;
}

export interface PromptVersionReference {
  manifestVersionId?: string;
  phasePromptVersionId?: string;
  rolePromptVersionIds?: string[];
  schemaVersionId?: string;
  toolPromptVersionId?: string;
}

export interface PromptDependencyReference {
  type: PromptSetType;
  name: string;
  label: string;
}

export interface PromptSetSummary {
  id: string;
  type: PromptSetType;
  name: string;
  title: string;
  format: "text" | "json";
  publishedVersionId?: string;
  publishedVersionNumber?: number;
  publishedAt?: string;
  draftUpdatedAt: string;
  hasUnpublishedChanges: boolean;
}

export interface PromptDraft {
  promptSetId: string;
  type: PromptSetType;
  name: string;
  title: string;
  format: "text" | "json";
  content: string;
  updatedAt: string;
}

export interface PromptPublishedVersion {
  id: string;
  promptSetId: string;
  versionNumber: number;
  format: "text" | "json";
  content: string;
  createdAt: string;
  publishedAt: string;
  notes?: string;
}

export interface PromptValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  dependencies: PromptDependencyReference[];
}

export interface PromptSetDetails {
  summary: PromptSetSummary;
  draft: PromptDraft;
  publishedVersion?: PromptPublishedVersion;
  versions: PromptPublishedVersion[];
  validation: PromptValidationResult;
}

export interface PublishPromptRequest {
  notes?: string;
}

export interface OutputSetRecord {
  id: string;
  sessionId: string;
  phase: Phase | "decision";
  runId: string;
  status: OutputStatus;
  supersedesOutputSetId?: string;
  causedByEditId?: string;
  createdAt: string;
}

export interface GraphNodeRecord {
  id: string;
  sessionId: string;
  phase: Phase | "decision";
  runId: string;
  outputSetId: string;
  nodeType: NodeType;
  status: OutputStatus;
  content: Record<string, unknown>;
  sourceRole?: string;
  derivedFromNodeId?: string;
  createdAt: string;
}

export interface GraphEdgeRecord {
  id: string;
  sessionId: string;
  phase: Phase | "decision";
  runId: string;
  outputSetId: string;
  edgeType: string;
  fromNodeId: string;
  toNodeId: string;
  status: OutputStatus;
  metadata?: Record<string, unknown>;
}

export interface ExportRecord {
  id: string;
  sessionId: string;
  format: "markdown" | "pdf";
  status: "running" | "failed" | "completed";
  artifact: string;
  errorCode?: string;
  retryCount?: number;
  createdAt: string;
}

export interface ModeratorEditRecord {
  id: string;
  sessionId: string;
  phase: Phase | "decision";
  editedNodeId?: string;
  editType: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
}

export interface SessionDetails {
  session: SessionRecord;
  phaseRuns: PhaseRunRecord[];
  outputSets: OutputSetRecord[];
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
  exports: ExportRecord[];
  edits: ModeratorEditRecord[];
}

export interface SessionSummary {
  id: string;
  title: string;
  problemStatement: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
}
