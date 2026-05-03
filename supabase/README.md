# Supabase setup

1. Maak een Supabase project.
2. Plak `supabase/schema.sql` in de SQL editor en voer het script uit.
3. Zet in Vercel deze environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Zet Supabase Auth aan met email magic links.

Voor GPX bulk import vanaf je eigen machine zet je lokaal in `.env.local` ook:

- `SUPABASE_SERVICE_ROLE_KEY`

Die key is alleen voor server-side scripts. Zet hem niet in Vercel als public key
en geef hem nooit de prefix `NEXT_PUBLIC_`.

De huidige app gebruikt Supabase Presence voor live posities. De tabellen in
`schema.sql` zijn alvast voorbereid voor routes, ritten, leden, dagschema's,
kaartpunten en optionele persistente live-locaties. Geimporteerde routes worden
als publieke routes uit de tabel `routes` gelezen.
