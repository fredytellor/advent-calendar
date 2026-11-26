begin;

create table public.calendar_cards (
  day integer primary key check (day between 1 and 24),
  card_image text check (card_image ~ ('^' || day::text || '/[a-f0-9-]{36}[.](jpg|png|webp)$'))
);

insert into public.calendar_cards (day)
select generate_series(1, 24);

alter table public.calendar_cards enable row level security;
revoke all on table public.calendar_cards from public, anon, authenticated;
grant select on table public.calendar_cards to anon, authenticated;
grant update (card_image) on table public.calendar_cards to authenticated;

create policy read_calendar_cards on public.calendar_cards
for select to anon, authenticated using (true);

create policy edit_calendar_cards on public.calendar_cards
for update to authenticated
using (public.is_editor())
with check (public.is_editor());

-- Public downloads are intentional for the dedicated decorative bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('calendar-cards', 'calendar-cards', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']);

create policy view_calendar_card_objects on storage.objects
for select to authenticated using (bucket_id = 'calendar-cards' and public.is_editor());

create policy upload_calendar_card_objects on storage.objects
for insert to authenticated with check (
  bucket_id = 'calendar-cards'
  and public.is_editor()
  and name ~ '^([1-9]|1[0-9]|2[0-4])/[a-f0-9-]{36}[.](jpg|png|webp)$'
);

create policy remove_unused_calendar_card_objects on storage.objects
for delete to authenticated using (
  bucket_id = 'calendar-cards' and public.is_editor()
  and not exists (
    select 1 from public.calendar_cards as card where card.card_image = storage.objects.name
  )
);

-- The card can be saved by itself, or in the same transaction as a memory.
-- Lock its row to return the actual previous path for Storage cleanup.
create function public.save_calendar_day(p_day integer, p_card_image text, p_memory jsonb default null)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  previous_path text;
begin
  if not public.is_editor() then
    raise exception 'Editor permission is required' using errcode = '42501';
  end if;

  select card_image into strict previous_path
  from public.calendar_cards
  where day = p_day
  for update;

  if p_card_image is not null and not exists (
    select 1 from storage.objects where bucket_id = 'calendar-cards' and name = p_card_image
  ) then
    raise exception 'Calendar card image was not found';
  end if;

  if p_memory is not null and p_memory <> 'null'::jsonb then
    insert into public.memories (day, title, description, photos, music_url)
    values (p_day, p_memory ->> 'title', p_memory ->> 'description', p_memory -> 'photos', p_memory ->> 'music_url')
    on conflict (day) do update set
      title = excluded.title,
      description = excluded.description,
      photos = excluded.photos,
      music_url = excluded.music_url;
  end if;

  update public.calendar_cards
  set card_image = p_card_image
  where day = p_day;

  return previous_path;
end;
$$;

revoke execute on function public.save_calendar_day(integer, text, jsonb) from public, anon;
grant execute on function public.save_calendar_day(integer, text, jsonb) to authenticated;

commit;
