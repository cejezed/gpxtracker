create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Rijder',
  created_at timestamptz not null default now()
);

create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  gpx_file_path text,
  geojson jsonb,
  distance_km numeric,
  created_at timestamptz not null default now()
);

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  route_id uuid references public.routes(id) on delete set null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.trip_members (
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'rider',
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

create table if not exists public.live_locations (
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  speed_kmh double precision,
  heading double precision,
  updated_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

alter table public.profiles enable row level security;
alter table public.routes enable row level security;
alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.live_locations enable row level security;

create policy "Profiles are readable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

create policy "Users manage own profile"
  on public.profiles for all
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "Owners manage routes"
  on public.routes for all
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "Trip members can read trips"
  on public.trips for select
  to authenticated
  using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.trip_members tm
      where tm.trip_id = trips.id and tm.user_id = auth.uid()
    )
  );

create policy "Owners manage trips"
  on public.trips for all
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

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

create policy "Trip owners manage members"
  on public.trip_members for all
  to authenticated
  using (
    exists (
      select 1 from public.trips t
      where t.id = trip_members.trip_id and t.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.trips t
      where t.id = trip_members.trip_id and t.owner_id = auth.uid()
    )
  );

create policy "Trip members can read live locations"
  on public.live_locations for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.trip_members tm
      where tm.trip_id = live_locations.trip_id and tm.user_id = auth.uid()
    )
    or exists (
      select 1 from public.trips t
      where t.id = live_locations.trip_id and t.owner_id = auth.uid()
    )
  );

create policy "Users write own live location"
  on public.live_locations for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
