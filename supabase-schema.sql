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
