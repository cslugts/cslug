-- up
create table cslug_ai_conversations (
  id uuid primary key,
  agent text not null,
  owner_type text,
  owner_id text,
  title text,
  metadata jsonb not null default '{}',
  message_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cslug_ai_conversations_owner_idx on cslug_ai_conversations (owner_type, owner_id, updated_at desc);

create table cslug_ai_messages (
  conversation_id uuid not null references cslug_ai_conversations (id) on delete cascade,
  position integer not null,
  role text not null,
  content jsonb not null,
  run_id uuid,
  created_at timestamptz not null default now(),
  primary key (conversation_id, position)
);

create table cslug_ai_runs (
  id uuid primary key,
  agent text not null,
  model text not null,
  conversation_id uuid references cslug_ai_conversations (id) on delete set null,
  user_id text,
  status text not null,
  steps integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(12, 6),
  error text,
  started_at timestamptz not null,
  finished_at timestamptz not null
);
create index cslug_ai_runs_started_idx on cslug_ai_runs (started_at desc);
create index cslug_ai_runs_user_idx on cslug_ai_runs (user_id, started_at desc);

-- down
drop table cslug_ai_runs;
drop table cslug_ai_messages;
drop table cslug_ai_conversations;
