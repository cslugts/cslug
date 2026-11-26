-- up
create table todos (id uuid primary key, title text not null, due_on date, created_at timestamptz not null default now());
-- down
drop table todos;
