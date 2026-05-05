create extension if not exists pgcrypto;

alter table public.trips
  add column if not exists share_code text;

update public.trips
set share_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
where share_code is null;

alter table public.trips
  alter column share_code set not null;

create unique index if not exists trips_share_code_key on public.trips (share_code);

alter table public.trips
  alter column share_code set default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

create table if not exists public.trip_routes (
  trip_id uuid not null references public.trips(id) on delete cascade,
  route_id uuid not null references public.routes(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (trip_id, route_id)
);

alter table public.trip_routes enable row level security;

drop policy if exists "Public routes are readable" on public.routes;
drop policy if exists "Authenticated route access" on public.routes;
drop policy if exists "Trip members can read trips" on public.trips;
drop policy if exists "Authenticated can find active trips" on public.trips;
drop policy if exists "Trip members can read members" on public.trip_members;
drop policy if exists "Users can join active trips" on public.trip_members;
drop policy if exists "Trip members can read trip routes" on public.trip_routes;
drop policy if exists "Trip members manage trip routes" on public.trip_routes;

create policy "Authenticated route access"
  on public.routes for select
  to authenticated
  using (
    is_public = true
    or auth.uid() = owner_id
    or exists (
      select 1
      from public.trip_routes tr
      join public.trips t on t.id = tr.trip_id
      left join public.trip_members tm on tm.trip_id = tr.trip_id and tm.user_id = auth.uid()
      where tr.route_id = routes.id
        and (t.owner_id = auth.uid() or tm.user_id = auth.uid())
    )
  );

create policy "Authenticated can find active trips"
  on public.trips for select
  to authenticated
  using (
    active = true
    or owner_id = auth.uid()
    or exists (
      select 1 from public.trip_members tm
      where tm.trip_id = trips.id and tm.user_id = auth.uid()
    )
  );

create policy "Trip members can read members"
  on public.trip_members for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.trips t
      where t.id = trip_members.trip_id and t.owner_id = auth.uid()
    )
  );

create policy "Users can join active trips"
  on public.trip_members for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.trips t
      where t.id = trip_members.trip_id and t.active = true
    )
  );

create policy "Trip members can read trip routes"
  on public.trip_routes for select
  to authenticated
  using (
    exists (
      select 1 from public.trips t
      where t.id = trip_routes.trip_id and t.owner_id = auth.uid()
    )
    or exists (
      select 1 from public.trip_members tm
      where tm.trip_id = trip_routes.trip_id and tm.user_id = auth.uid()
    )
  );

create policy "Trip members manage trip routes"
  on public.trip_routes for all
  to authenticated
  using (
    exists (
      select 1 from public.trips t
      where t.id = trip_routes.trip_id and t.owner_id = auth.uid()
    )
    or exists (
      select 1 from public.trip_members tm
      where tm.trip_id = trip_routes.trip_id and tm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.trips t
      where t.id = trip_routes.trip_id and t.owner_id = auth.uid()
    )
    or exists (
      select 1 from public.trip_members tm
      where tm.trip_id = trip_routes.trip_id and tm.user_id = auth.uid()
    )
  );

create or replace function public.list_trip_members(p_trip_id uuid)
returns table(user_id uuid, email text, member_role text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Login vereist.';
  end if;

  if not exists (
    select 1
    from public.trips t
    left join public.trip_members tm on tm.trip_id = t.id and tm.user_id = auth.uid()
    where t.id = p_trip_id
      and (t.owner_id = auth.uid() or tm.user_id = auth.uid())
  ) then
    raise exception 'Geen toegang tot deze groepsrit.';
  end if;

  return query
  select tm.user_id, au.email::text, tm.role::text, tm.created_at
  from public.trip_members tm
  join auth.users au on au.id = tm.user_id
  where tm.trip_id = p_trip_id
  order by
    case tm.role when 'owner' then 0 else 1 end,
    tm.created_at;
end;
$$;

revoke all on function public.list_trip_members(uuid) from public;
grant execute on function public.list_trip_members(uuid) to authenticated;

create or replace function public.add_trip_member_by_email(
  p_trip_id uuid,
  p_email text,
  p_role text default 'rider'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(coalesce(p_email, '')));
  target_user_id uuid;
  normalized_role text := lower(trim(coalesce(p_role, 'rider')));
begin
  if auth.uid() is null then
    raise exception 'Login vereist.';
  end if;

  if normalized_email = '' then
    raise exception 'Emailadres ontbreekt.';
  end if;

  if not exists (
    select 1 from public.trips t
    where t.id = p_trip_id and t.owner_id = auth.uid()
  ) then
    raise exception 'Alleen de eigenaar van de groepsrit kan leden beheren.';
  end if;

  select au.id
  into target_user_id
  from auth.users au
  where lower(au.email) = normalized_email
  limit 1;

  if target_user_id is null then
    raise exception 'Geen gebruiker gevonden met dit e-mailadres.';
  end if;

  if normalized_role not in ('rider', 'navigator') then
    normalized_role := 'rider';
  end if;

  insert into public.trip_members (trip_id, user_id, role)
  values (p_trip_id, target_user_id, normalized_role)
  on conflict (trip_id, user_id) do update
  set role = excluded.role;

  return target_user_id;
end;
$$;

revoke all on function public.add_trip_member_by_email(uuid, text, text) from public;
grant execute on function public.add_trip_member_by_email(uuid, text, text) to authenticated;

create or replace function public.remove_trip_member_by_email(p_trip_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(coalesce(p_email, '')));
  target_user_id uuid;
  trip_owner_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Login vereist.';
  end if;

  if normalized_email = '' then
    raise exception 'Emailadres ontbreekt.';
  end if;

  select t.owner_id
  into trip_owner_id
  from public.trips t
  where t.id = p_trip_id;

  if trip_owner_id is distinct from auth.uid() then
    raise exception 'Alleen de eigenaar van de groepsrit kan leden beheren.';
  end if;

  select au.id
  into target_user_id
  from auth.users au
  where lower(au.email) = normalized_email
  limit 1;

  if target_user_id is null then
    raise exception 'Geen gebruiker gevonden met dit e-mailadres.';
  end if;

  if target_user_id = trip_owner_id then
    raise exception 'De eigenaar kan niet uit de eigen groepsrit worden verwijderd.';
  end if;

  delete from public.trip_members tm
  where tm.trip_id = p_trip_id and tm.user_id = target_user_id;

  return target_user_id;
end;
$$;

revoke all on function public.remove_trip_member_by_email(uuid, text) from public;
grant execute on function public.remove_trip_member_by_email(uuid, text) to authenticated;
