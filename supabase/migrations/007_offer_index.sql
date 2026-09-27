-- Kareer : base d'offres alimentée en continu (collecte France Travail, puis autres sources).
-- La table job_offers (002) devient l'index central : recherche instantanée, alertes, agent, mesures.

alter table public.job_offers
  add column if not exists fingerprint text,        -- entreprise + intitulé + lieu normalisés (doublons entre sources)
  add column if not exists rome_code text,          -- code métier ROME (France Travail, puis ROMEO pour les autres sources)
  add column if not exists departement text,        -- « 13 », « 2A », « 971 »…
  add column if not exists partner text,            -- site partenaire d'origine (offres partenaires de France Travail)
  add column if not exists apply_kind text,         -- canal de candidature : email | lever | greenhouse | lba | platform | unknown
  add column if not exists apply_host text,         -- famille de la page de candidature : workday, taleez, indeed, francetravail…
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists active boolean not null default true;

-- Recherche plein texte (français) sur l'intitulé et l'entreprise
alter table public.job_offers
  add column if not exists search tsvector
  generated always as (to_tsvector('french', coalesce(title, '') || ' ' || coalesce(company, ''))) stored;

create index if not exists job_offers_search on public.job_offers using gin (search);
create index if not exists job_offers_active_dep on public.job_offers (departement, published_at desc) where active;
create index if not exists job_offers_rome on public.job_offers (rome_code) where active;
create index if not exists job_offers_fingerprint on public.job_offers (fingerprint);
create index if not exists job_offers_source_seen on public.job_offers (source, last_seen_at);

-- État de la collecte, par source et par zone (reprise incrémentale, suivi)
create table if not exists public.ingest_state (
  source text not null,
  partition text not null,                          -- ex. « dep:13 »
  last_success_at timestamptz,                      -- fin de la dernière collecte réussie de la zone
  last_full_at timestamptz,                         -- dernier balayage complet (détection des offres retirées)
  last_error text,
  stats jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (source, partition)
);

-- Réservé au serveur (aucune politique : le navigateur n'y a pas accès)
alter table public.ingest_state enable row level security;
