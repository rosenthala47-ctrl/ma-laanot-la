-- ============================================================
-- Cloud sync tables for ma-laanot-la
-- Run this ONCE in Supabase Dashboard → SQL Editor → New query
-- Paste everything below, click "Run".
-- ============================================================

-- 1) Conversation history per crush
create table if not exists public.crush_interactions (
  id uuid primary key default gen_random_uuid(),
  crush_id uuid not null references public.crushes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text,
  style text,
  situation text,
  input text,
  output jsonb,
  check_score int,
  check_verdict text,
  created_at timestamptz not null default now()
);

create index if not exists crush_interactions_crush_idx
  on public.crush_interactions(crush_id, created_at desc);

create index if not exists crush_interactions_user_idx
  on public.crush_interactions(user_id, created_at desc);

alter table public.crush_interactions enable row level security;

drop policy if exists "own_interactions_all" on public.crush_interactions;
create policy "own_interactions_all" on public.crush_interactions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2) Reply ratings (👍/👎 per reply)
create table if not exists public.reply_ratings (
  user_id uuid not null references auth.users(id) on delete cascade,
  rating_key text not null,
  rating text not null check (rating in ('up','down')),
  updated_at timestamptz not null default now(),
  primary key (user_id, rating_key)
);

alter table public.reply_ratings enable row level security;

drop policy if exists "own_ratings_all" on public.reply_ratings;
create policy "own_ratings_all" on public.reply_ratings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
