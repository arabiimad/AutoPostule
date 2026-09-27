-- Kareer : auto-candidature (politique, offres, file de tâches durable, tentatives d'envoi, preuves).
-- Principes :
--   * l'état d'exécution (automation_tasks) est distinct du statut de recrutement (applications) ;
--   * une seule tentative par candidat et par offre (contrainte d'unicité) ;
--   * les transitions qui prouvent un envoi sont réservées au serveur (service_role) ;
--   * RLS partout : chaque utilisateur ne lit que ses lignes ; les jetons OAuth ne sont jamais lisibles côté client.

-- ---------------------------------------------------------------------------
-- Politique d'automatisation (réglée par l'utilisateur)
-- ---------------------------------------------------------------------------
create table if not exists public.automation_policies (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default false,          -- activation explicite obligatoire
  paused boolean not null default false,           -- pause immédiate, vérifiée avant chaque envoi
  roles text[] not null default '{}',              -- métiers recherchés
  contracts text[] not null default '{}',          -- cdi, cdd, alternance, stage, freelance (vide = tous)
  locations text[] not null default '{}',
  remote text[] not null default '{}',             -- total, hybride, sur-site (vide = tous)
  min_salary integer,
  min_fit integer not null default 60 check (min_fit between 0 and 100),
  excluded_companies text[] not null default '{}',
  excluded_keywords text[] not null default '{}',
  channels text[] not null default '{email}' check (channels <@ array['email', 'form']::text[]),
  daily_limit integer not null default 5 check (daily_limit between 1 and 20),
  follow_ups boolean not null default false,       -- relances automatiques désactivées par défaut
  updated_at timestamptz not null default now()
);

-- Réponses personnelles aux questions des formulaires (jamais inventées par l'IA)
create table if not exists public.personal_answers (
  user_id uuid not null references auth.users (id) on delete cascade,
  question_key text not null,                      -- clé normalisée (« disponibilite », « permis-b »…)
  question text not null,
  answer text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, question_key)
);

-- ---------------------------------------------------------------------------
-- Offres canoniques (données publiques, partagées ; écrites par le serveur)
-- ---------------------------------------------------------------------------
create table if not exists public.job_offers (
  id text primary key,                             -- clé canonique (source + référence)
  source text not null,
  source_ref text not null,
  title text not null,
  company text not null default '',
  location text not null default '',
  contract text,                                   -- null = non précisé (jamais supposé)
  offer_url text not null,
  apply_channel jsonb,                             -- { kind: email|lever|greenhouse|unknown, target, detectedAt }
  published_at timestamptz,                        -- null si la source ne la donne pas (jamais « aujourd'hui » par défaut)
  discovered_at timestamptz not null default now(),
  verified_at timestamptz,
  expires_at timestamptz,
  data jsonb not null default '{}'::jsonb
);
create index if not exists job_offers_discovered on public.job_offers (discovered_at desc);

-- ---------------------------------------------------------------------------
-- File de tâches durable (réservation exclusive, bail, reprise)
-- ---------------------------------------------------------------------------
create table if not exists public.automation_tasks (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('search', 'process_offer', 'verify_submission', 'track_replies')),
  offer_id text references public.job_offers (id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed', 'needs_user', 'uncertain', 'cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists automation_tasks_ready on public.automation_tasks (run_after) where status in ('queued', 'running');
create index if not exists automation_tasks_user on public.automation_tasks (user_id, created_at desc);
-- Une seule tâche active par candidat et par offre
create unique index if not exists automation_tasks_one_active_per_offer
  on public.automation_tasks (user_id, offer_id, kind) where status in ('queued', 'running') and offer_id is not null;

-- ---------------------------------------------------------------------------
-- Tentatives d'envoi (une par candidat et par offre) et preuves
-- ---------------------------------------------------------------------------
create table if not exists public.application_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  offer_id text not null references public.job_offers (id) on delete restrict,
  channel text not null check (channel in ('email', 'lever', 'greenhouse')),
  destination text not null,                       -- adresse ou URL exacte, résolue par le serveur
  status text not null default 'reserved'
    check (status in ('reserved', 'submitting', 'submitted', 'confirmed', 'uncertain', 'failed', 'needs_user', 'cancelled')),
  profile_version text,                            -- empreinte du profil utilisé
  documents jsonb not null default '[]'::jsonb,    -- [{ kind, name, sha256, bytes }]
  answers jsonb not null default '{}'::jsonb,
  proof jsonb,                                     -- { provider, messageId, acceptedAt } / { confirmationText, url }
  error text,
  created_at timestamptz not null default now(),
  submitting_at timestamptz,
  submitted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, offer_id)
);
create index if not exists application_attempts_user_day on public.application_attempts (user_id, created_at desc);

-- Journal des évènements (supervision, fil d'activité de l'utilisateur)
create table if not exists public.automation_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id bigint references public.automation_tasks (id) on delete set null,
  attempt_id uuid references public.application_attempts (id) on delete set null,
  type text not null,
  message text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists automation_events_user on public.automation_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Connexions de messagerie (OAuth Gmail / Outlook) : jetons chiffrés par le serveur
-- ---------------------------------------------------------------------------
create table if not exists public.mail_connections (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('gmail', 'outlook')),
  email text not null,
  status text not null default 'active' check (status in ('active', 'revoked', 'error')),
  scopes text[] not null default '{}',
  access_token_enc text,                           -- chiffré (AES-256-GCM) côté serveur, jamais exposé au client
  refresh_token_enc text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

-- updated_at automatique
drop trigger if exists automation_policies_touch on public.automation_policies;
create trigger automation_policies_touch before update on public.automation_policies for each row execute function public.touch_updated_at();
drop trigger if exists automation_tasks_touch on public.automation_tasks;
create trigger automation_tasks_touch before update on public.automation_tasks for each row execute function public.touch_updated_at();
drop trigger if exists application_attempts_touch on public.application_attempts;
create trigger application_attempts_touch before update on public.application_attempts for each row execute function public.touch_updated_at();
drop trigger if exists mail_connections_touch on public.mail_connections;
create trigger mail_connections_touch before update on public.mail_connections for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Fonctions serveur (service_role uniquement)
-- ---------------------------------------------------------------------------

-- Réserve jusqu'à p_limit tâches prêtes pour un worker (FOR UPDATE SKIP LOCKED : jamais deux fois la même).
-- Une tâche dont le bail a expiré (worker arrêté) est reprise ; au-delà de max_attempts elle passe en échec.
create or replace function public.claim_automation_tasks(p_worker text, p_limit integer default 1, p_lease_seconds integer default 300)
returns setof public.automation_tasks language plpgsql security definer set search_path = '' as $$
begin
  update public.automation_tasks t
     set status = 'failed', last_error = coalesce(t.last_error, 'Nombre maximal de tentatives atteint.'), locked_by = null, locked_until = null
   where t.status = 'running' and t.locked_until < now() and t.attempts >= t.max_attempts;

  return query
  update public.automation_tasks t
     set status = 'running', locked_by = p_worker, locked_until = now() + make_interval(secs => p_lease_seconds), attempts = t.attempts + 1
   where t.id in (
     select c.id from public.automation_tasks c
      where (c.status = 'queued' and c.run_after <= now())
         or (c.status = 'running' and c.locked_until < now() and c.attempts < c.max_attempts)
      order by c.run_after, c.id
      for update skip locked
      limit greatest(p_limit, 1))
  returning t.*;
end $$;

-- Termine une tâche détenue par ce worker (garde : un worker dont le bail a été repris ne peut plus écrire).
create or replace function public.finish_automation_task(
  p_id bigint, p_worker text, p_status text, p_error text default null, p_retry_seconds integer default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if p_status not in ('done', 'failed', 'needs_user', 'uncertain', 'cancelled', 'queued') then
    raise exception 'statut invalide: %', p_status;
  end if;
  update public.automation_tasks
     set status = case when p_status = 'queued' and attempts >= max_attempts then 'failed' else p_status end,
         last_error = p_error,
         run_after = case when p_status = 'queued' then now() + make_interval(secs => coalesce(p_retry_seconds, 60)) else run_after end,
         locked_by = null, locked_until = null
   where id = p_id and locked_by = p_worker and status = 'running';
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Réserve le droit d'envoyer une candidature, de façon atomique :
-- automatisation active et non en pause, limite quotidienne, aucun envoi antérieur pour cette offre.
-- Une tentative qui n'a jamais atteint l'envoi (réservée, annulée, en attente d'action, refusée par le
-- fournisseur) est reprise ; dès l'état « submitting », plus aucun nouvel envoi n'est possible (ALREADY_ATTEMPTED).
-- Renvoie l'identifiant de la tentative, ou null avec la raison.
create or replace function public.reserve_application_attempt(
  p_user uuid, p_offer text, p_channel text, p_destination text, p_profile_version text, p_documents jsonb, p_answers jsonb,
  out attempt_id uuid, out reason text)
language plpgsql security definer set search_path = '' as $$
declare pol public.automation_policies; today_count integer; prev public.application_attempts; has_prev boolean;
begin
  -- Sérialise les réservations d'un même candidat (limite quotidienne exacte même avec plusieurs workers)
  perform pg_advisory_xact_lock(hashtext('attempts:' || p_user::text));
  select * into pol from public.automation_policies where user_id = p_user;
  if not found or not pol.enabled then reason := 'AUTOMATION_DISABLED'; return; end if;
  if pol.paused then reason := 'AUTOMATION_PAUSED'; return; end if;
  select * into prev from public.application_attempts where user_id = p_user and offer_id = p_offer;
  has_prev := found;
  if has_prev and prev.status in ('submitting', 'submitted', 'confirmed', 'uncertain') then
    reason := 'ALREADY_ATTEMPTED'; return;
  end if;
  select count(*) into today_count from public.application_attempts
   where user_id = p_user and created_at >= date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris'
     and status not in ('failed', 'cancelled', 'needs_user');
  if today_count >= pol.daily_limit then reason := 'DAILY_LIMIT'; return; end if;
  if has_prev then
    update public.application_attempts
       set status = 'reserved', channel = p_channel, destination = p_destination, profile_version = p_profile_version,
           documents = coalesce(p_documents, '[]'), answers = coalesce(p_answers, '{}'), error = null, created_at = now()
     where id = prev.id
    returning id into attempt_id;
  else
    insert into public.application_attempts (user_id, offer_id, channel, destination, profile_version, documents, answers)
    values (p_user, p_offer, p_channel, p_destination, p_profile_version, coalesce(p_documents, '[]'), coalesce(p_answers, '{}'))
    returning id into attempt_id;
  end if;
end $$;

-- Résultat d'un envoi. Seuls ces passages sont permis :
--   submitting → submitted | uncertain | failed (refus explicite du fournisseur : rien n'a été envoyé)
--   submitted | uncertain → confirmed (preuve de réception trouvée)
--   reserved → needs_user | cancelled | failed (avant tout envoi)
create or replace function public.record_submission(p_attempt uuid, p_status text, p_proof jsonb default null, p_error text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare a public.application_attempts;
begin
  select * into a from public.application_attempts where id = p_attempt for update;
  if not found then return false; end if;
  if not (
       (a.status = 'submitting' and p_status in ('submitted', 'uncertain', 'failed'))
    or (a.status in ('submitted', 'uncertain') and p_status = 'confirmed')
    or (a.status = 'reserved' and p_status in ('needs_user', 'cancelled', 'failed'))
  ) then return false; end if;
  update public.application_attempts
     set status = p_status,
         proof = coalesce(p_proof, proof),
         error = p_error,
         submitted_at = case when p_status = 'submitted' then now() else submitted_at end
   where id = p_attempt;
  return true;
end $$;
revoke all on function public.record_submission(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_submission(uuid, text, jsonb, text) to service_role;

-- Passe une tentative à l'état « envoi en cours » juste avant l'action, en revérifiant la pause.
-- Après cet état, un délai dépassé donne « uncertain » : jamais de nouvel envoi aveugle.
create or replace function public.begin_submission(p_attempt uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare a public.application_attempts; pol public.automation_policies;
begin
  select * into a from public.application_attempts where id = p_attempt for update;
  if not found then return 'NOT_FOUND'; end if;
  if a.status <> 'reserved' then return 'NOT_RESERVED'; end if;
  select * into pol from public.automation_policies where user_id = a.user_id;
  if not found or not pol.enabled or pol.paused then
    update public.application_attempts set status = 'cancelled', error = 'Automatisation désactivée ou en pause avant l''envoi.' where id = p_attempt;
    return 'PAUSED';
  end if;
  update public.application_attempts set status = 'submitting', submitting_at = now() where id = p_attempt;
  return 'OK';
end $$;

revoke all on function public.claim_automation_tasks(text, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_automation_task(bigint, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.reserve_application_attempt(uuid, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.begin_submission(uuid) from public, anon, authenticated;
grant execute on function public.claim_automation_tasks(text, integer, integer) to service_role;
grant execute on function public.finish_automation_task(bigint, text, text, text, integer) to service_role;
grant execute on function public.reserve_application_attempt(uuid, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.begin_submission(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS et droits
-- ---------------------------------------------------------------------------
alter table public.automation_policies enable row level security;
alter table public.personal_answers enable row level security;
alter table public.job_offers enable row level security;
alter table public.automation_tasks enable row level security;
alter table public.application_attempts enable row level security;
alter table public.automation_events enable row level security;
alter table public.mail_connections enable row level security;

drop policy if exists "politique : lecture" on public.automation_policies;
drop policy if exists "politique : création" on public.automation_policies;
drop policy if exists "politique : modification" on public.automation_policies;
create policy "politique : lecture" on public.automation_policies for select to authenticated using ((select auth.uid()) = user_id);
create policy "politique : création" on public.automation_policies for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "politique : modification" on public.automation_policies for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "réponses : propriétaire" on public.personal_answers;
create policy "réponses : propriétaire" on public.personal_answers for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "offres : lecture" on public.job_offers;
create policy "offres : lecture" on public.job_offers for select to authenticated using (true);

-- Tâches, tentatives et évènements : lecture seule pour le propriétaire ; écritures par le serveur uniquement
drop policy if exists "tâches : lecture" on public.automation_tasks;
create policy "tâches : lecture" on public.automation_tasks for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "tentatives : lecture" on public.application_attempts;
create policy "tentatives : lecture" on public.application_attempts for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "évènements : lecture" on public.automation_events;
create policy "évènements : lecture" on public.automation_events for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "messagerie : lecture" on public.mail_connections;
drop policy if exists "messagerie : suppression" on public.mail_connections;
create policy "messagerie : lecture" on public.mail_connections for select to authenticated using ((select auth.uid()) = user_id);
create policy "messagerie : suppression" on public.mail_connections for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update on public.automation_policies to authenticated;
grant select, insert, update, delete on public.personal_answers to authenticated;
grant select on public.job_offers, public.automation_tasks, public.application_attempts, public.automation_events to authenticated;
revoke insert, update, delete on public.job_offers, public.automation_tasks, public.application_attempts, public.automation_events from authenticated, anon;
-- Jetons OAuth : colonnes jamais lisibles par le client
revoke all on public.mail_connections from authenticated, anon;
grant select (user_id, provider, email, status, scopes, expires_at, created_at, updated_at) on public.mail_connections to authenticated;
grant delete on public.mail_connections to authenticated;
grant all on all tables in schema public to service_role;
