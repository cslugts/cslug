-- up
-- Accent-insensitive copies of the built-in text search configurations: cslug_french, cslug_english, cslug_simple…
-- (unaccent first, then the language's own dictionary), so to_tsvector and ts_headline ignore accents alike.
create extension if not exists unaccent;
create extension if not exists pg_trgm;
do $$
declare
  c record;
  dicts text;
begin
  for c in select cfgname from pg_ts_config where cfgnamespace = 'pg_catalog'::regnamespace loop
    if exists (select 1 from pg_ts_config where cfgname = 'cslug_' || c.cfgname) then
      continue;
    end if;
    select string_agg(quote_ident(d.dictname), ', ' order by m.mapseqno) into dicts
      from pg_ts_config_map m join pg_ts_dict d on d.oid = m.mapdict
      where m.mapcfg = ('pg_catalog.' || quote_ident(c.cfgname))::regconfig
        and m.maptokentype = (select tokid from ts_token_type('default') where alias = 'word');
    execute format('create text search configuration %I (copy = pg_catalog.%I)', 'cslug_' || c.cfgname, c.cfgname);
    execute format('alter text search configuration %I alter mapping for hword, hword_part, word with unaccent, %s',
      'cslug_' || c.cfgname, dicts);
  end loop;
end
$$;

-- down
do $$
declare
  c record;
begin
  for c in select cfgname from pg_ts_config where cfgname like 'cslug\_%' loop
    execute format('drop text search configuration %I', c.cfgname);
  end loop;
end
$$;
