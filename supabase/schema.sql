create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Rijder',
  created_at timestamptz not null default now()
);

create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  name text not null,
  country text not null default 'Onbekend',
  route_type text not null default '4x4',
  route_group text,
  file_name text,
  gpx_file_path text,
  geojson jsonb,
  distance_km numeric,
  elevation_gain_m numeric,
  elevation_loss_m numeric,
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.routes
  alter column owner_id drop not null;

alter table public.routes
  add column if not exists country text not null default 'Onbekend';

alter table public.routes
  add column if not exists route_type text not null default '4x4';

alter table public.routes
  add column if not exists route_group text;

alter table public.routes
  add column if not exists file_name text;

alter table public.routes
  add column if not exists elevation_gain_m numeric;

alter table public.routes
  add column if not exists elevation_loss_m numeric;

alter table public.routes
  add column if not exists is_public boolean not null default true;

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
  accuracy_m double precision,
  updated_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

alter table public.live_locations
  add column if not exists accuracy_m double precision;

create table if not exists public.day_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  plan_date date,
  created_at timestamptz not null default now()
);

create table if not exists public.day_plan_items (
  id uuid primary key default gen_random_uuid(),
  day_plan_id uuid not null references public.day_plans(id) on delete cascade,
  route_id uuid not null references public.routes(id) on delete cascade,
  order_index integer not null,
  planned_start_time time,
  break_minutes integer not null default 0,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.map_points (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  day_plan_id uuid references public.day_plans(id) on delete cascade,
  name text not null,
  point_type text not null default 'note',
  lat double precision not null,
  lng double precision not null,
  note text,
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.routes enable row level security;
alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.live_locations enable row level security;
alter table public.day_plans enable row level security;
alter table public.day_plan_items enable row level security;
alter table public.map_points enable row level security;

drop policy if exists "Profiles are readable by authenticated users" on public.profiles;
drop policy if exists "Users manage own profile" on public.profiles;
drop policy if exists "Owners manage routes" on public.routes;
drop policy if exists "Public routes are readable" on public.routes;
drop policy if exists "Trip members can read trips" on public.trips;
drop policy if exists "Owners manage trips" on public.trips;
drop policy if exists "Trip members can read members" on public.trip_members;
drop policy if exists "Trip owners manage members" on public.trip_members;
drop policy if exists "Trip members can read live locations" on public.live_locations;
drop policy if exists "Users write own live location" on public.live_locations;
drop policy if exists "Owners manage day plans" on public.day_plans;
drop policy if exists "Owners manage day plan items" on public.day_plan_items;
drop policy if exists "Owners manage map points" on public.map_points;

create policy "Profiles are readable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

create policy "Users manage own profile"
  on public.profiles for all
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "Public routes are readable"
  on public.routes for select
  to anon, authenticated
  using (is_public = true or auth.uid() = owner_id);

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

create policy "Owners manage day plans"
  on public.day_plans for all
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "Owners manage day plan items"
  on public.day_plan_items for all
  to authenticated
  using (
    exists (
      select 1 from public.day_plans dp
      where dp.id = day_plan_items.day_plan_id and dp.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.day_plans dp
      where dp.id = day_plan_items.day_plan_id and dp.owner_id = auth.uid()
    )
  );

create policy "Owners manage map points"
  on public.map_points for all
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
