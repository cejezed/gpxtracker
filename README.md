# GPX Tracker

Next.js MVP voor offroad GPX-routes met OpenStreetMap, lokale GPX-import,
Supabase-routebibliotheek en live groepslocatie.

## Functies

- GPX-routes bekijken op OpenStreetMap.
- Filteren op land en route-type.
- Dagschema maken met meerdere etappes, starttijden, pauzes en notities.
- Meerdere geplande routes tegelijk op de kaart tonen.
- Offroad/Roadtrip routefilters met duidelijke iconen.
- Kaartpunten toevoegen via GPS-coordinaten, huidige locatie of route-eindpunt.
- GPX-dropfolder importeren naar Supabase met land/type herkenning.
- Live groepslocatie via Supabase Presence.

## Lokaal starten

```bash
npm install
npm run dev
```

Open daarna `http://localhost:3000`.

## Supabase

Maak `.env.local` en vul je Supabase projectgegevens in:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

Voer daarna `supabase/schema.sql` uit in Supabase.

Voor bulk importeren van GPX-bestanden heb je lokaal ook deze server-side key nodig:

```bash
SUPABASE_SERVICE_ROLE_KEY=
```

Zet `SUPABASE_SERVICE_ROLE_KEY` niet in de frontend en niet als `NEXT_PUBLIC_*`.

## GPX importeren naar Supabase

Zet nieuwe bestanden in `imports/`, eventueel in submappen:

```text
imports/
  lake district/
    route-1.gpx
```

Controleer lokaal eerst of alle GPX-bestanden gelezen kunnen worden:

```bash
npm run import:gpx:dry-run
```

Importeer daarna naar Supabase:

```bash
npm run import:gpx
```

Bestanden onder `imports/` staan in `.gitignore`, dus die map is bedoeld als lokale dropfolder.
