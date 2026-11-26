-- up
create table ledger (
  id serial primary key,
  event_id text not null,
  amount integer not null
);

-- down
drop table ledger;
