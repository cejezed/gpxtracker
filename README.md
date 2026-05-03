# GPX Tracker

Next.js MVP voor offroad GPX-routes met OpenStreetMap, lokale GPX-import en
Supabase-ready live groepslocatie.

## Functies

- GPX-routes bekijken op OpenStreetMap.
- Filteren op land en route-type.
- Dagschema maken met meerdere etappes, starttijden, pauzes en notities.
- Meerdere geplande routes tegelijk op de kaart tonen.
- Offroad/Roadtrip routefilters met duidelijke iconen.
- Kaartpunten toevoegen via GPS-coordinaten, huidige locatie of route-eindpunt.
- Live groepslocatie via Supabase Presence.

## Lokaal starten

```bash
npm install
npm run dev
```

Open daarna `http://localhost:3000`.

## Supabase

Kopieer `.env.example` naar `.env.local` en vul je Supabase projectgegevens in:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

Voer daarna `supabase/schema.sql` uit in Supabase.
