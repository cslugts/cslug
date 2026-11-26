-- up
create table users (
  id uuid primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- down
drop table users;
