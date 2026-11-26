-- up
create table cslug_notifications (
  id uuid primary key,
  recipient_id text,
  type text not null,
  data jsonb not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index cslug_notifications_recipient_idx on cslug_notifications (recipient_id, created_at desc);

create table cslug_notification_deliveries (
  id uuid primary key,
  recipient_id text,
  type text not null,
  channel text not null,
  status text not null,
  message jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cslug_notification_deliveries_status_idx on cslug_notification_deliveries (status, created_at);

-- down
drop table cslug_notification_deliveries;
drop table cslug_notifications;
