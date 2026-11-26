-- up
create table notes (id serial primary key, body text not null);
-- down
drop table notes;
