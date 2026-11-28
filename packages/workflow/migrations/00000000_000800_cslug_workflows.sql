-- up
create table cslug_workflow_runs (
  id text primary key,
  workflow text not null,
  status text not null default 'pending',
  input jsonb,
  output jsonb,
  error jsonb,
  waiting_for text,
  waiting_match jsonb,
  wake_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index cslug_workflow_runs_status_idx on cslug_workflow_runs (status, wake_at);
create index cslug_workflow_runs_waiting_idx on cslug_workflow_runs (waiting_for) where status = 'waiting';

create table cslug_workflow_steps (
  run_id text not null references cslug_workflow_runs (id) on delete cascade,
  seq integer not null,
  name text not null,
  kind text not null,
  status text not null,
  result jsonb,
  error jsonb,
  attempts integer not null default 0,
  wake_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, seq)
);

create table cslug_workflow_signals (
  id uuid primary key,
  run_id text not null references cslug_workflow_runs (id) on delete cascade,
  name text not null,
  data jsonb,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
create index cslug_workflow_signals_waiting_idx on cslug_workflow_signals (run_id, name, created_at)
  where consumed_at is null;

-- down
drop table cslug_workflow_signals;
drop table cslug_workflow_steps;
drop table cslug_workflow_runs;
