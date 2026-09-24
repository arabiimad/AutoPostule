-- AutoPostule : schéma initial (profils, candidatures, forfaits, usage)
-- Les documents « profil » et « candidature » sont stockés en JSONB (même modèle que l'application).
-- Sécurité : RLS activée partout ; chaque utilisateur ne voit que ses lignes.
-- Forfaits et compteurs d'usage : écrits uniquement par le serveur (clé service_role).

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.applications (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  data jsonb not null,
  status text generated always as (data ->> 'status') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists applications_user_updated on public.applications (user_id, updated_at desc);

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'premium')),
  status text not null default 'active',
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  period text not null,          -- 'AAAA-MM'
  kind text not null,            -- 'cv', 'letter', 'rewrite', 'interview'…
  count integer not null default 0,
  primary key (user_id, period, kind)
);

-- Mise à jour automatique de updated_at
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists applications_touch on public.applications;
create trigger applications_touch before update on public.applications for each row execute function public.touch_updated_at();

-- Incrément atomique de l'usage (appelé par le serveur)
create or replace function public.increment_usage(p_user uuid, p_period text, p_kind text, p_amount integer default 1)
returns integer language sql security definer set search_path = '' as $$
  insert into public.usage (user_id, period, kind, count) values (p_user, p_period, p_kind, p_amount)
  on conflict (user_id, period, kind) do update set count = public.usage.count + excluded.count
  returning count;
$$;
revoke all on function public.increment_usage(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.increment_usage(uuid, text, text, integer) to service_role;

-- RLS
alter table public.profiles enable row level security;
alter table public.applications enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage enable row level security;

drop policy if exists "profil : lecture" on public.profiles;
drop policy if exists "profil : création" on public.profiles;
drop policy if exists "profil : modification" on public.profiles;
drop policy if exists "profil : suppression" on public.profiles;
create policy "profil : lecture" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "profil : création" on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy "profil : modification" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "profil : suppression" on public.profiles for delete to authenticated using ((select auth.uid()) = id);

drop policy if exists "candidatures : lecture" on public.applications;
drop policy if exists "candidatures : création" on public.applications;
drop policy if exists "candidatures : modification" on public.applications;
drop policy if exists "candidatures : suppression" on public.applications;
create policy "candidatures : lecture" on public.applications for select to authenticated using ((select auth.uid()) = user_id);
create policy "candidatures : création" on public.applications for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "candidatures : modification" on public.applications for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "candidatures : suppression" on public.applications for delete to authenticated using ((select auth.uid()) = user_id);

-- Forfait et usage : lecture seule pour l'utilisateur
drop policy if exists "forfait : lecture" on public.subscriptions;
create policy "forfait : lecture" on public.subscriptions for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "usage : lecture" on public.usage;
create policy "usage : lecture" on public.usage for select to authenticated using ((select auth.uid()) = user_id);

-- Temps réel sur les candidatures (synchronisation entre onglets / appareils)
do $$ begin
  alter publication supabase_realtime add table public.applications;
exception when duplicate_object then null; end $$;
