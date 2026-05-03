# GPX Tracker

Next.js MVP voor offroad GPX-routes met OpenStreetMap, lokale GPX-import en
Supabase-ready live groepslocatie.

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
