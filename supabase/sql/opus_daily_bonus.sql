-- ============================================================================
-- Free daily Opus bonus — server-authoritative, tamper-proof.
-- Run ONCE in Supabase → SQL Editor. Safe to re-run (idempotent).
--
-- A free user gets 1 Opus-quality generation per day. The count lives in a
-- table that ONLY the service role can touch (RLS on, no client policies), so
-- it cannot be reset from the browser/localStorage.
-- ============================================================================

create table if not exists public.opus_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);

-- Lock the table down: RLS on, and revoke all client access. The edge function
-- uses the service role (which bypasses RLS) via the RPC below.
alter table public.opus_daily_usage enable row level security;
revoke all on public.opus_daily_usage from anon, authenticated;

-- Atomically consume one bonus for (uid, day) if under the daily limit.
-- Returns true only when a bonus was available and has now been spent.
create or replace function public.consume_opus_bonus(uid uuid, d date, lim int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare cur int;
begin
  insert into public.opus_daily_usage(user_id, day, count)
    values (uid, d, 0)
    on conflict (user_id, day) do nothing;

  select count into cur from public.opus_daily_usage
    where user_id = uid and day = d
    for update;

  if cur < lim then
    update public.opus_daily_usage set count = count + 1
      where user_id = uid and day = d;
    return true;
  end if;
  return false;
end;
$$;

-- Only the service role (used by the edge function) may call it.
revoke all on function public.consume_opus_bonus(uuid, date, int) from public, anon, authenticated;
grant execute on function public.consume_opus_bonus(uuid, date, int) to service_role;

-- Make PostgREST aware of the new function immediately.
notify pgrst, 'reload schema';
