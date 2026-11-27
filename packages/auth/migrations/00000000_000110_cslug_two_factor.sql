-- up
-- TOTP second factor, one row per user: the secret (encrypted with APP_KEY), when it was confirmed, the hashes of the
-- unused recovery codes, and the last time step accepted (a code is never accepted twice).
create table cslug_two_factor (
  user_id text primary key,
  secret text not null,
  confirmed_at timestamptz,
  recovery_codes jsonb not null default '[]',
  last_counter bigint not null default 0,
  created_at timestamptz not null default now()
);

-- down
drop table cslug_two_factor;
