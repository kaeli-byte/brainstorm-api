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

alter table phase_runs
  add column if not exists prompt_version_refs jsonb;

create index if not exists idx_prompt_sets_type_name on prompt_sets (type, name);
create index if not exists idx_prompt_versions_set_published on prompt_versions (prompt_set_id, published_at desc);
create index if not exists idx_prompt_publish_events_set_created on prompt_publish_events (prompt_set_id, created_at desc);
