-- up
create table cslug_queue_outbox (
  id uuid primary key,
  envelope text not null,
  options text not null,
  created_at timestamptz not null default now()
);
create index cslug_queue_outbox_created_at_idx on cslug_queue_outbox (created_at);

-- down
drop table cslug_queue_outbox;
