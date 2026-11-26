begin;

alter table public.group_banner
  add column background_music_url text
  check (background_music_url ~ '^https://(www[.]youtube[.]com|music[.]youtube[.]com)/watch[?]v=[A-Za-z0-9_-]{11}$');

-- The existing table SELECT grant covers the new column. Application roles
-- still have no direct write privilege on this table.
create function public.save_background_music(p_url text, p_expected_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_editor() then
    raise exception 'Editor permission is required' using errcode = '42501';
  end if;

  update public.group_banner
  set background_music_url = p_url
  where id = 1 and background_music_url is not distinct from p_expected_url;

  if not found then
    raise exception 'The background music has changed' using errcode = '40001';
  end if;
end;
$$;

revoke execute on function public.save_background_music(text, text) from public, anon;
grant execute on function public.save_background_music(text, text) to authenticated;

commit;
