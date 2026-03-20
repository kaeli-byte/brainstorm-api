create table if not exists sessions (
  id text primary key,
  title text not null,
  problem_statement text not null,
  roles jsonb not null,
  context jsonb,
  state text not null,
  active_output_set_ids jsonb not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists phase_runs (
  id text primary key,
  session_id text not null,
  phase text not null,
  status text not null,
  attempt_number integer not null,
  trigger_type text not null,
  triggered_by_phase_run_id text,
  error_code text,
  error_category text,
  retry_count integer,
  diagnostics jsonb,
  prompt_template_version text,
  role_config_version text,
  schema_version text,
  provider text,
  model text,
  started_at text not null,
  completed_at text
);

create table if not exists output_sets (
  id text primary key,
  session_id text not null,
  phase text not null,
  run_id text not null,
  status text not null,
  supersedes_output_set_id text,
  caused_by_edit_id text,
  created_at text not null
);

create table if not exists graph_nodes (
  id text primary key,
  session_id text not null,
  phase text not null,
  run_id text not null,
  output_set_id text not null,
  node_type text not null,
  status text not null,
  content jsonb not null,
  source_role text,
  derived_from_node_id text,
  created_at text not null
);

create table if not exists graph_edges (
  id text primary key,
  session_id text not null,
  phase text not null,
  run_id text not null,
  output_set_id text not null,
  edge_type text not null,
  from_node_id text not null,
  to_node_id text not null,
  status text not null,
  metadata jsonb
);

create table if not exists exports (
  id text primary key,
  session_id text not null,
  format text not null,
  status text not null,
  artifact text not null,
  error_code text,
  retry_count integer,
  created_at text not null
);

create table if not exists moderator_edits (
  id text primary key,
  session_id text not null,
  phase text not null,
  edited_node_id text,
  edit_type text not null,
  before_payload jsonb not null,
  after_payload jsonb not null,
  created_at text not null
);

create index if not exists idx_phase_runs_session_phase on phase_runs (session_id, phase);
create index if not exists idx_output_sets_session_phase_status on output_sets (session_id, phase, status);
create index if not exists idx_graph_nodes_session_output_type_status on graph_nodes (session_id, output_set_id, node_type, status);
create index if not exists idx_graph_edges_session_output_status on graph_edges (session_id, output_set_id, status);
create index if not exists idx_exports_session on exports (session_id);
create index if not exists idx_moderator_edits_session_created on moderator_edits (session_id, created_at);
