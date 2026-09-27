-- Kareer : synchronisation fiable entre appareils (téléphone, ordinateur) et avec le worker.
--  * profiles.version / applications.version : incrémentées à chaque modification ;
--  * patch_application : modifie seulement les champs envoyés (fusion JSONB) au lieu de réécrire tout le dossier,
--    ce qui préserve les changements faits ailleurs (autre appareil, candidature automatique) ;
--  * save_profile : enregistrement conditionnel (version attendue) → conflit signalé, jamais d'écrasement silencieux.
-- Fonctions en « security invoker » : les règles RLS (chaque utilisateur ne touche que ses lignes) s'appliquent.

alter table public.profiles add column if not exists version bigint not null default 1;
alter table public.applications add column if not exists version bigint not null default 1;

create or replace function public.bump_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.version := coalesce(old.version, 0) + 1;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_version on public.profiles;
create trigger profiles_version before update on public.profiles for each row execute function public.bump_version();
drop trigger if exists applications_version on public.applications;
create trigger applications_version before update on public.applications for each row execute function public.bump_version();

-- Modification partielle d'un dossier (champs de premier niveau fusionnés ; null supprime la valeur).
create or replace function public.patch_application(p_id text, p_patch jsonb)
returns table (version bigint, data jsonb)
language sql security invoker set search_path = '' as $$
  update public.applications a
     set data = (a.data || coalesce(p_patch, '{}'::jsonb))
                - coalesce((select array_agg(e.k) from jsonb_each(coalesce(p_patch, '{}'::jsonb)) e(k, v) where e.v = 'null'::jsonb), '{}'::text[])
   where a.user_id = (select auth.uid()) and a.id = p_id
  returning a.version, a.data;
$$;

-- Enregistrement du profil si la version attendue est toujours la dernière (null : création ou écrasement voulu).
create or replace function public.save_profile(p_data jsonb, p_expected bigint)
returns table (ok boolean, version bigint, data jsonb)
language plpgsql security invoker set search_path = '' as $$
declare cur public.profiles; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'non connecté'; end if;
  select * into cur from public.profiles p where p.id = uid for update;
  if not found then
    insert into public.profiles (id, data) values (uid, p_data) returning public.profiles.version, public.profiles.data into version, data;
    ok := true; return next; return;
  end if;
  if p_expected is not null and cur.version <> p_expected then
    ok := false; version := cur.version; data := cur.data; return next; return;
  end if;
  update public.profiles p set data = p_data where p.id = uid returning p.version, p.data into version, data;
  ok := true; return next;
end $$;

grant execute on function public.patch_application(text, jsonb) to authenticated;
grant execute on function public.save_profile(jsonb, bigint) to authenticated;
revoke execute on function public.patch_application(text, jsonb) from public, anon;
revoke execute on function public.save_profile(jsonb, bigint) from public, anon;
