-- Enable the vector extension
create extension if not exists vector;

-- Drop existing table if it exists
drop table if exists documents;

-- Create the documents table with vector support
create table documents (
  id bigserial primary key,
  content text,
  embedding vector(1536)
);

-- Create an index for better vector search performance
create index on documents 
using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

-- Enable RLS but allow all operations for now
alter table documents enable row level security;
create policy "Allow all" on documents for all using (true);