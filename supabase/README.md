# Supabase setup

1. Maak een Supabase project.
2. Plak `supabase/schema.sql` in de SQL editor en voer het script uit.
3. Zet in Vercel deze environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Zet Supabase Auth aan met email magic links.

De huidige app gebruikt Supabase Presence voor live posities. De tabellen in
`schema.sql` zijn alvast voorbereid voor routes, ritten, leden en optionele
persistente live-locaties.
