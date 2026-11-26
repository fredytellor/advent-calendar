begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('background-music', 'background-music', true, 15728640, array['audio/mpeg']);

-- Public URLs serve the audio. Browser-facing roles cannot write to this bucket.
create policy background_music_dashboard_insert on storage.objects
as restrictive for insert to anon, authenticated
with check (bucket_id <> 'background-music');

create policy background_music_dashboard_update on storage.objects
as restrictive for update to anon, authenticated
using (bucket_id <> 'background-music')
with check (bucket_id <> 'background-music');

create policy background_music_dashboard_delete on storage.objects
as restrictive for delete to anon, authenticated
using (bucket_id <> 'background-music');

alter table public.group_banner
  drop constraint group_banner_background_music_url_check,
  add constraint group_banner_background_music_url_check check (
    background_music_url is null
    or background_music_url ~ '^https://(www[.]youtube[.]com|music[.]youtube[.]com)/watch[?]v=[A-Za-z0-9_-]{11}$'
    or (
      background_music_url ~ $mp3$^https://[a-z0-9-]+([.]storage)?[.]supabase[.]co/storage/v1/object/public/background-music/(([-A-Za-z0-9._~!$&'()*+,;=:@]|%[0-9a-fA-F]{2})+/)*([-A-Za-z0-9._~!$&'()*+,;=:@]|%[0-9a-fA-F]{2})+[.][mM][pP]3([?][^#[:space:]]*)?$$mp3$
      and split_part(background_music_url, '?', 1) !~* '/([.]|%2e){1,2}/'
    )
  );

commit;
