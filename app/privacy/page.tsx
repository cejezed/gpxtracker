import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacybeleid | RallyTrail",
  description: "Privacybeleid voor RallyTrail."
};

export default function PrivacyPage() {
  return (
    <main className="privacy-page">
      <article className="privacy-document">
        <Link href="/" className="privacy-back">
          Terug naar RallyTrail
        </Link>

        <h1>Privacybeleid RallyTrail</h1>
        <p className="privacy-updated">Laatst bijgewerkt: 5 mei 2026</p>

        <section>
          <h2>Welke gegevens RallyTrail gebruikt</h2>
          <p>
            RallyTrail gebruikt gegevens die nodig zijn om routes te tonen, ritten te plannen, live groepslocatie te
            delen en routes op te nemen. Het gaat om accountgegevens zoals e-mailadres, een gekozen weergavenaam,
            GPX-routes, kaartpunten, geplande routes en locatiegegevens wanneer je locatie of opname inschakelt.
          </p>
        </section>

        <section>
          <h2>Locatiegegevens</h2>
          <p>
            De app gebruikt je locatie om je positie op de kaart te tonen, route-opnames te maken en je live locatie
            met andere deelnemers in dezelfde rit te delen. Live locatie wordt alleen gedeeld wanneer je dit inschakelt
            en bent ingelogd. RallyTrail probeert alleen nauwkeurige GPS-posities te gebruiken voor live delen en
            route-opnames.
          </p>
        </section>

        <section>
          <h2>Opslag en verwerking</h2>
          <p>
            RallyTrail gebruikt Supabase voor login, routegegevens, kaartpunten en optionele live groepsfuncties.
            OpenStreetMap-kaarten en OSRM-routing kunnen worden gebruikt om kaarten te tonen en roadtrip-routes over
            wegen te berekenen. Deze externe diensten kunnen technische gegevens zoals IP-adres en verzoekinformatie
            verwerken volgens hun eigen voorwaarden.
          </p>
        </section>

        <section>
          <h2>Delen van gegevens</h2>
          <p>
            Je live locatie is bedoeld voor andere ingelogde deelnemers binnen dezelfde rit of groep. Publieke routes
            kunnen zichtbaar zijn voor andere gebruikers van RallyTrail. RallyTrail verkoopt geen persoonsgegevens.
          </p>
        </section>

        <section>
          <h2>Bewaren en verwijderen</h2>
          <p>
            Routes, kaartpunten en accountgegevens worden bewaard zolang ze nodig zijn voor het gebruik van de app of
            totdat ze worden verwijderd. Je kunt verzoeken om accountgegevens, routes of opgeslagen locaties te laten
            verwijderen via het contactadres dat bij RallyTrail in Google Play wordt vermeld.
          </p>
        </section>

        <section>
          <h2>Toestemmingen</h2>
          <p>
            RallyTrail vraagt locatietoestemming om GPS-functies te gebruiken. Zonder locatietoestemming kun je nog
            steeds routes bekijken, maar live locatie, eigen positie en route-opname werken dan niet.
          </p>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Voor privacyvragen of verwijderverzoeken kun je contact opnemen via het ontwikkelaarscontact dat in Google
            Play Console bij RallyTrail is ingesteld.
          </p>
        </section>
      </article>
    </main>
  );
}
