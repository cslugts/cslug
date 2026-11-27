-- up
-- Registered only with `search.vectors: true` (config/search.ts): needs the pgvector extension on the server.
create extension if not exists vector;
create table cslug_search_embeddings (
  index text not null,
  key text not null,
  -- the embedder's model: vectors of another model are ignored, and re-embedded on the next upsert
  model text not null,
  -- a hash of the embedded text, so unchanged documents are not embedded again
  hash text not null,
  embedding vector not null,
  primary key (index, key),
  foreign key (index, key) references cslug_search_documents (index, key) on delete cascade
);

-- down
drop table cslug_search_embeddings;
