-- Framework table for db.idempotent(): the first result of an operation, replayed on repeats.
-- up
create table cslug_idempotency (
  scope text not null,
  key text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (scope, key)
);

-- down
drop table cslug_idempotency;
