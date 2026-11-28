-- up
create table effects (id uuid primary key, run_id text not null, name text not null);
-- down
drop table effects;
