begin;

create table public.group_banner (
  id integer primary key check (id = 1),
  image_path text check (
    image_path ~ '^photo/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'
  ),
  revision integer not null default 0 check (revision >= 0)
);

insert into public.group_banner (id) values (1);

-- Keep retired paths so a delayed Storage deletion cannot race with republication.
create table public.retired_group_banner_images (
  image_path text primary key check (
    image_path ~ '^photo/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'
  )
);

alter table public.group_banner enable row level security;
alter table public.retired_group_banner_images enable row level security;
revoke all on table public.group_banner, public.retired_group_banner_images from public, anon, authenticated;
grant select on table public.group_banner to anon, authenticated;
grant select on table public.retired_group_banner_images to authenticated;

create policy read_group_banner on public.group_banner
for select to anon, authenticated using (true);

create policy read_retired_group_banner_images on public.retired_group_banner_images
for select to authenticated using (public.is_editor());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('group-banner', 'group-banner', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']);

create policy view_group_banner_objects on storage.objects
for select to authenticated using (bucket_id = 'group-banner' and public.is_editor());

create policy upload_group_banner_objects on storage.objects
for insert to authenticated with check (
  bucket_id = 'group-banner'
  and public.is_editor()
  and name ~ '^photo/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'
  and not exists (
    select 1 from public.retired_group_banner_images as retired
    where retired.image_path = storage.objects.name
  )
);

create policy delete_retired_group_banner_objects on storage.objects
for delete to authenticated using (
  bucket_id = 'group-banner'
  and public.is_editor()
  and exists (
    select 1 from public.retired_group_banner_images as retired
    where retired.image_path = storage.objects.name
  )
  and not exists (
    select 1 from public.group_banner as banner
    where banner.image_path = storage.objects.name
  )
);

-- Application roles can change configuration only through these editor-authorized functions.
create function public.save_group_banner(p_image_path text, p_expected_revision integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_path text;
  current_revision integer;
begin
  if not public.is_editor() then
    raise exception 'Editor permission is required' using errcode = '42501';
  end if;

  select image_path, revision into strict previous_path, current_revision
  from public.group_banner where id = 1 for update;

  if current_revision is distinct from p_expected_revision then
    raise exception 'The banner has changed' using errcode = '40001';
  end if;

  if p_image_path is not null and (
    exists (
      select 1 from public.retired_group_banner_images where image_path = p_image_path
    ) or not exists (
      select 1 from storage.objects where bucket_id = 'group-banner' and name = p_image_path
    )
  ) then
    raise exception 'The banner image is unavailable';
  end if;

  if previous_path is distinct from p_image_path then
    if previous_path is not null then
      insert into public.retired_group_banner_images (image_path) values (previous_path)
      on conflict do nothing;
    end if;

    current_revision := current_revision + 1;
    update public.group_banner
    set image_path = p_image_path, revision = current_revision
    where id = 1;
  else
    previous_path := null;
  end if;

  return jsonb_build_object('image_path', p_image_path, 'revision', current_revision, 'previous_path', previous_path);
end;
$$;

create function public.retire_group_banner_upload(p_image_path text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_path text;
begin
  if not public.is_editor() then
    raise exception 'Editor permission is required' using errcode = '42501';
  end if;

  select image_path into strict current_path
  from public.group_banner where id = 1 for update;

  if p_image_path is null or p_image_path is not distinct from current_path then
    return false;
  end if;

  insert into public.retired_group_banner_images (image_path) values (p_image_path)
  on conflict do nothing;
  return true;
end;
$$;

revoke execute on function public.save_group_banner(text, integer) from public, anon;
revoke execute on function public.retire_group_banner_upload(text) from public, anon;
grant execute on function public.save_group_banner(text, integer) to authenticated;
grant execute on function public.retire_group_banner_upload(text) to authenticated;

commit;
