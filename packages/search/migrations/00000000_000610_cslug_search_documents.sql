-- up
-- Documents that are not table rows (pages, files, messages), one row per (index, key). `config` is the document's
-- text search configuration (a regconfig, so the generated vector stays immutable).
create table cslug_search_documents (
  index text not null,
  key text not null,
  title text not null default '',
  body text not null default '',
  config regconfig not null default 'cslug_simple',
  metadata jsonb not null default '{}',
  vector tsvector generated always as (
    setweight(to_tsvector(config, title), 'A') || setweight(to_tsvector(config, body), 'B')
  ) stored,
  updated_at timestamptz not null,
  primary key (index, key)
);
create index cslug_search_documents_vector_idx on cslug_search_documents using gin (vector);
create index cslug_search_documents_title_trgm_idx on cslug_search_documents using gin (title gin_trgm_ops);

-- down
drop table cslug_search_documents;
