create extension if not exists pgcrypto;

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
  add column if not exists gpx_file_path text;

alter table public.routes
  add column if not exists geojson jsonb;

alter table public.routes
  add column if not exists distance_km numeric;

alter table public.routes
  add column if not exists elevation_gain_m numeric;

alter table public.routes
  add column if not exists elevation_loss_m numeric;

alter table public.routes
  add column if not exists is_public boolean not null default true;

alter table public.routes enable row level security;

drop policy if exists "Owners manage routes" on public.routes;
drop policy if exists "Public routes are readable" on public.routes;

create policy "Public routes are readable"
  on public.routes for select
  to anon, authenticated
  using (is_public = true or auth.uid() = owner_id);

create policy "Owners manage routes"
  on public.routes for all
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
