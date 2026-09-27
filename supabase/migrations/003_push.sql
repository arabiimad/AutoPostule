-- Kareer : notifications sur le téléphone (Web Push) pour l'auto-candidature.
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists "notifications : lecture" on public.push_subscriptions;
drop policy if exists "notifications : suppression" on public.push_subscriptions;
create policy "notifications : lecture" on public.push_subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy "notifications : suppression" on public.push_subscriptions for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.push_subscriptions from anon, authenticated;
grant select (endpoint, user_id, user_agent, created_at), delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;
