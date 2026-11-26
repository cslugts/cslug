-- up
create table cslug_access_tokens (
  id uuid primary key,
  user_id text not null,
  name text not null,
  token_hash text not null,
  abilities jsonb not null default '["*"]',
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index cslug_access_tokens_user_id_idx on cslug_access_tokens (user_id);

-- down
drop table cslug_access_tokens;
