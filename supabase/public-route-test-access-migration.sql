drop policy if exists "Authenticated route access" on public.routes;
drop policy if exists "Public and scoped route access" on public.routes;

create policy "Public and scoped route access"
  on public.routes for select
  to anon, authenticated
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
