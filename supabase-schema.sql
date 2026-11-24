-- Словник: таблица для колод, карточек и статистики.
-- Выполните этот файл один раз: Supabase → SQL Editor → New query → вставить → Run.

create table if not exists public.docs (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  path       text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

alter table public.docs enable row level security;

drop policy if exists "Каждый видит и меняет только свои записи" on public.docs;
create policy "Каждый видит и меняет только свои записи"
  on public.docs
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.docs to authenticated;
revoke all on public.docs from anon;

-- «Будильник»: GitHub раз в три дня вызывает эту функцию, чтобы бесплатный проект не засыпал без активности.
create table if not exists public.heartbeat (
  id integer primary key,
  at timestamptz not null default now()
);
alter table public.heartbeat enable row level security;

create or replace function public.keepalive()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  insert into public.heartbeat (id, at) values (1, now())
  on conflict (id) do update set at = excluded.at
  returning at;
$$;

revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;
