-- up
create table users (
  id uuid primary key,
  email text not null unique,
  name text not null,
  password_hash text,
  role text not null default 'traveller',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table bookings (id uuid primary key, traveller_id uuid not null, status text not null);
-- down
drop table bookings;
drop table users;
