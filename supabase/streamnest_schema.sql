-- StreamNest v2 schema: accounts, AI artists, songs and generation jobs.
-- Intended for StreamNest's dedicated Supabase project only.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  handle text not null unique,
  avatar_color text not null default '#FF6B5A',
  bio text not null default '',
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.creators (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  creator_type text not null check (creator_type in ('human','ai')),
  name text not null,
  handle text not null unique,
  avatar_color text not null default '#00E1D6',
  bio text not null default '',
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_agents (
  creator_id uuid primary key references public.creators(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  personality text not null,
  genres text[] not null default '{}',
  creative_direction text not null default '',
  voice_style text not null default '',
  system_prompt text not null default '',
  autonomy_level text not null default 'manual' check (autonomy_level in ('manual','assisted','autonomous')),
  monthly_generation_limit integer not null default 10 check (monthly_generation_limit between 0 and 500),
  generation_budget_cents integer not null default 0 check (generation_budget_cents >= 0),
  memory jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  lyrics text not null default '',
  audio_url text,
  cover_url text,
  provider text,
  provider_job_id text,
  duration_seconds integer,
  status text not null default 'draft' check (status in ('draft','generating','ready','published','failed')),
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  song_id uuid references public.songs(id) on delete set null,
  provider text not null,
  concept text not null default '',
  prompt text not null default '',
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  cost_cents integer not null default 0 check (cost_cents >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists creators_owner_idx on public.creators(owner_user_id);
create index if not exists creators_type_idx on public.creators(creator_type);
create index if not exists ai_agents_owner_idx on public.ai_agents(owner_user_id);
create index if not exists songs_creator_idx on public.songs(creator_id, created_at desc);
create index if not exists songs_public_idx on public.songs(is_public, status, created_at desc);
create index if not exists songs_owner_idx on public.songs(owner_user_id);
create index if not exists generation_jobs_owner_idx on public.generation_jobs(owner_user_id, created_at desc);
create index if not exists generation_jobs_creator_idx on public.generation_jobs(creator_id);
create index if not exists generation_jobs_song_idx on public.generation_jobs(song_id);

alter table public.profiles enable row level security;
alter table public.creators enable row level security;
alter table public.ai_agents enable row level security;
alter table public.songs enable row level security;
alter table public.generation_jobs enable row level security;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.creators from anon, authenticated;
revoke all on table public.ai_agents from anon, authenticated;
revoke all on table public.songs from anon, authenticated;
revoke all on table public.generation_jobs from anon, authenticated;

grant select on table public.profiles to anon, authenticated;
grant insert, update, delete on table public.profiles to authenticated;
grant select on table public.creators to anon, authenticated;
grant insert, update, delete on table public.creators to authenticated;
grant select, insert, update, delete on table public.ai_agents to authenticated;
grant select on table public.songs to anon, authenticated;
grant insert, update, delete on table public.songs to authenticated;
grant select, insert, update, delete on table public.generation_jobs to authenticated;

drop policy if exists profiles_public_read on public.profiles;
create policy profiles_public_read on public.profiles for select to anon, authenticated using (true);
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
drop policy if exists profiles_delete_self on public.profiles;
create policy profiles_delete_self on public.profiles for delete to authenticated using ((select auth.uid()) = id);

drop policy if exists creators_public_read on public.creators;
create policy creators_public_read on public.creators for select to anon, authenticated using (is_public = true or (select auth.uid()) = owner_user_id);
drop policy if exists creators_insert_owner on public.creators;
create policy creators_insert_owner on public.creators for insert to authenticated with check ((select auth.uid()) = owner_user_id);
drop policy if exists creators_update_owner on public.creators;
create policy creators_update_owner on public.creators for update to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
drop policy if exists creators_delete_owner on public.creators;
create policy creators_delete_owner on public.creators for delete to authenticated using ((select auth.uid()) = owner_user_id);

drop policy if exists ai_agents_owner_read on public.ai_agents;
create policy ai_agents_owner_read on public.ai_agents for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists ai_agents_owner_insert on public.ai_agents;
create policy ai_agents_owner_insert on public.ai_agents for insert to authenticated
with check ((select auth.uid()) = owner_user_id and exists (
  select 1 from public.creators c
  where c.id = creator_id and c.owner_user_id = (select auth.uid()) and c.creator_type = 'ai'
));
drop policy if exists ai_agents_owner_update on public.ai_agents;
create policy ai_agents_owner_update on public.ai_agents for update to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id and exists (
  select 1 from public.creators c
  where c.id = creator_id and c.owner_user_id = (select auth.uid()) and c.creator_type = 'ai'
));
drop policy if exists ai_agents_owner_delete on public.ai_agents;
create policy ai_agents_owner_delete on public.ai_agents for delete to authenticated using ((select auth.uid()) = owner_user_id);

drop policy if exists songs_public_or_owner_read on public.songs;
create policy songs_public_or_owner_read on public.songs for select to anon, authenticated
using ((is_public = true and status = 'published') or (select auth.uid()) = owner_user_id);
drop policy if exists songs_owner_insert on public.songs;
create policy songs_owner_insert on public.songs for insert to authenticated
with check ((select auth.uid()) = owner_user_id and exists (
  select 1 from public.creators c where c.id = creator_id and c.owner_user_id = (select auth.uid())
));
drop policy if exists songs_owner_update on public.songs;
create policy songs_owner_update on public.songs for update to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id and exists (
  select 1 from public.creators c where c.id = creator_id and c.owner_user_id = (select auth.uid())
));
drop policy if exists songs_owner_delete on public.songs;
create policy songs_owner_delete on public.songs for delete to authenticated using ((select auth.uid()) = owner_user_id);

drop policy if exists jobs_owner_read on public.generation_jobs;
create policy jobs_owner_read on public.generation_jobs for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists jobs_owner_insert on public.generation_jobs;
create policy jobs_owner_insert on public.generation_jobs for insert to authenticated
with check ((select auth.uid()) = owner_user_id and exists (
  select 1 from public.creators c where c.id = creator_id and c.owner_user_id = (select auth.uid())
));
drop policy if exists jobs_owner_update on public.generation_jobs;
create policy jobs_owner_update on public.generation_jobs for update to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);
drop policy if exists jobs_owner_delete on public.generation_jobs;
create policy jobs_owner_delete on public.generation_jobs for delete to authenticated using ((select auth.uid()) = owner_user_id);
-- StreamNest music generation extension
-- Adds generated audio storage and per-job duration controls.

alter table public.songs
  add column if not exists audio_path text;

alter table public.generation_jobs
  add column if not exists requested_duration_seconds integer not null default 30;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'generation_jobs_requested_duration_check'
      and conrelid = 'public.generation_jobs'::regclass
  ) then
    alter table public.generation_jobs
      add constraint generation_jobs_requested_duration_check
      check (requested_duration_seconds between 10 and 120);
  end if;
end $$;

create index if not exists songs_audio_path_idx on public.songs(audio_path) where audio_path is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'song-audio',
  'song-audio',
  false,
  52428800,
  array['audio/mpeg','audio/mp3']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Owners can read their own private song audio. Published songs may also be
-- signed/read by anonymous clients, while drafts remain private.
drop policy if exists streamnest_song_audio_select on storage.objects;
create policy streamnest_song_audio_select
on storage.objects for select
to anon, authenticated
using (
  bucket_id = 'song-audio'
  and (
    (storage.foldername(name))[1] = (select auth.uid()::text)
    or exists (
      select 1
      from public.songs s
      where s.audio_path = name
        and s.status = 'published'
        and s.is_public = true
    )
  )
);

-- The Edge Function performs normal generated-audio uploads with a server key.
-- These owner policies also allow future direct authenticated uploads without
-- broadening access outside a user's own folder.
drop policy if exists streamnest_song_audio_insert on storage.objects;
create policy streamnest_song_audio_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'song-audio'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists streamnest_song_audio_update on storage.objects;
create policy streamnest_song_audio_update
on storage.objects for update
to authenticated
using (
  bucket_id = 'song-audio'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'song-audio'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists streamnest_song_audio_delete on storage.objects;
create policy streamnest_song_audio_delete
on storage.objects for delete
to authenticated
using (
  bucket_id = 'song-audio'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
