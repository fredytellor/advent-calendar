begin;

-- A public bucket would bypass storage.objects SELECT policies.
do $$
begin
  if not exists (
    select 1 from storage.buckets where id = 'memories' and not public
  ) then
    raise exception 'Set the existing memories bucket to Private before applying this migration';
  end if;
end
$$;

alter table public.memories
  add column photos jsonb not null default '[]'::jsonb,
  add column music_url text;

update public.memories
set photos = jsonb_build_array(photo)
where photo is not null and photo <> '';

alter table public.memories
  add constraint memories_photos_valid check (
    case when jsonb_typeof(photos) = 'array' then
      jsonb_array_length(photos) <= 10
      and not jsonb_path_exists(photos, '$[*] ? (@.type() != "string" || @ == "")')
    else false end
  );

-- Keep the legacy column usable by pages opened before v1.1. A legacy
-- replacement updates the cover and keeps any other photos in their order.
create function public.sync_memory_cover() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.photos = '[]'::jsonb and nullif(new.photo, '') is not null then
      new.photos := jsonb_build_array(new.photo);
    end if;
  elsif new.photos is not distinct from old.photos
    and new.photo is distinct from old.photo then
    new.photos := case when nullif(new.photo, '') is null then new.photos - 0
                       else jsonb_build_array(new.photo) || (new.photos - 0)
                  end;
  end if;
  new.photo := new.photos ->> 0;
  return new;
end;
$$;

create trigger sync_memory_cover
before insert or update on public.memories
for each row execute function public.sync_memory_cover();

drop policy read_photos on storage.objects;

create policy read_photos on storage.objects for select using (
  bucket_id = 'memories' and (
    public.is_editor() or exists (
      select 1
      from public.memories as memory
      where memory.photos ? storage.objects.name
        and public.unlocked(memory.day)
    )
  )
);

commit;
