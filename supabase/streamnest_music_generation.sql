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
