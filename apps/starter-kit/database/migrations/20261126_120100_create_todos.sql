-- up
create table todos (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  title text not null,
  notes text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  due_on date,
  completed_at timestamptz,
  reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index todos_user_id_completed_at_idx on todos (user_id, completed_at);
create index todos_due_on_idx on todos (due_on);

-- down
drop table todos;
