create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text not null default '',
  category text not null default 'Other',
  tags text[] not null default '{}',
  video_path text not null unique,
  duration_seconds integer not null default 0,
  mime_type text not null default 'video/mp4',
  file_size_bytes bigint not null default 0,
  views bigint not null default 0,
  likes bigint not null default 0,
  dislikes bigint not null default 0,
  status text not null default 'published',
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint videos_title_length_check check (char_length(title) between 1 and 160),
  constraint videos_duration_check check (duration_seconds between 0 and 86400),
  constraint videos_file_size_check check (file_size_bytes >= 0),
  constraint videos_counts_check check (views >= 0 and likes >= 0 and dislikes >= 0),
  constraint videos_status_check check (status in ('draft','processing','published','failed'))
);

create index if not exists videos_owner_idx on public.videos(owner_user_id, created_at desc);
create index if not exists videos_public_idx on public.videos(created_at desc) where is_public = true and status = 'published';

alter table public.videos enable row level security;

drop policy if exists "streamnest_videos_select" on public.videos;
create policy "streamnest_videos_select" on public.videos
for select to anon, authenticated
using ((is_public = true and status = 'published') or (select auth.uid()) = owner_user_id);

drop policy if exists "streamnest_videos_insert" on public.videos;
create policy "streamnest_videos_insert" on public.videos
for insert to authenticated
with check ((select auth.uid()) = owner_user_id);

drop policy if exists "streamnest_videos_update" on public.videos;
create policy "streamnest_videos_update" on public.videos
for update to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);

drop policy if exists "streamnest_videos_delete" on public.videos;
create policy "streamnest_videos_delete" on public.videos
for delete to authenticated
using ((select auth.uid()) = owner_user_id);

grant select on public.videos to anon, authenticated;
grant insert, update, delete on public.videos to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('video-media','video-media',true,524288000,array['video/mp4','video/webm','video/quicktime','video/x-m4v']::text[])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "streamnest_video_media_insert" on storage.objects;
create policy "streamnest_video_media_insert" on storage.objects
for insert to authenticated
with check (bucket_id = 'video-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "streamnest_video_media_update" on storage.objects;
create policy "streamnest_video_media_update" on storage.objects
for update to authenticated
using (bucket_id = 'video-media' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'video-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "streamnest_video_media_delete" on storage.objects;
create policy "streamnest_video_media_delete" on storage.objects
for delete to authenticated
using (bucket_id = 'video-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
