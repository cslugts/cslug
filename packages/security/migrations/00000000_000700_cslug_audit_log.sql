-- up
create table cslug_audit_log (
  id uuid primary key,
  action text not null,
  user_id text,
  subject_type text,
  subject_id text,
  ip text,
  request_id text,
  data jsonb,
  created_at timestamptz not null default now()
);
create index cslug_audit_log_subject_idx on cslug_audit_log (subject_type, subject_id, created_at desc);
create index cslug_audit_log_user_idx on cslug_audit_log (user_id, created_at desc);
create index cslug_audit_log_created_idx on cslug_audit_log (created_at);

-- down
drop table cslug_audit_log;
