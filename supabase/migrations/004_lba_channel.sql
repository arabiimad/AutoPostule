-- Canal « lba » : envoi par l'API officielle de La bonne alternance (POST /job/v1/apply).
-- La contrainte de 002_automation.sql n'acceptait que email, lever et greenhouse.
alter table public.application_attempts drop constraint if exists application_attempts_channel_check;
alter table public.application_attempts
  add constraint application_attempts_channel_check check (channel in ('email', 'lever', 'greenhouse', 'lba'));
