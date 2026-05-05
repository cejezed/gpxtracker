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
