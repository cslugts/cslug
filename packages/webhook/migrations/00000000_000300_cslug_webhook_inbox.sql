-- up
create table cslug_webhook_inbox (
  id uuid primary key,
  source text not null,
  external_id text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  replayed_at timestamptz,
  unique (source, external_id)
);
create index cslug_webhook_inbox_received_at_idx on cslug_webhook_inbox (received_at);

-- down
drop table cslug_webhook_inbox;
