import type { RouteCountry, RouteType } from "@/lib/types";

export type SampleRoute = {
  group: "Wales" | "Hochsauerland";
  country: RouteCountry;
  routeType: RouteType;
  fileName: string;
  title: string;
  url: string;
};

const route = (
  group: SampleRoute["group"],
  fileName: string,
  title: string,
  country: RouteCountry,
  routeType: RouteType
): SampleRoute => ({
  group,
  country,
  routeType,
  fileName,
  title,
  url: `/gpx/${group}/${encodeURIComponent(fileName)}`
});

export const sampleRoutes: SampleRoute[] = [
  route("Wales", "wales-2-day-4x4.gpx", "Wales 2 Day 4x4", "Engeland", "4x4"),
  route("Wales", "tre-taliesin-goginan.gpx", "Tre Taliesin Goginan", "Engeland", "4x4"),
  route("Wales", "the-wayfarer.gpx", "The Wayfarer", "Engeland", "4x4"),
  route("Wales", "strata-florida.gpx", "Strata Florida", "Engeland", "4x4"),
  route("Wales", "rocky-steps.gpx", "Rocky Steps", "Engeland", "4x4"),
  route("Wales", "lost-lake.gpx", "Lost Lake", "Engeland", "4x4"),
  route("Wales", "llwyngwril-arthog.gpx", "Llwyngwril Arthog", "Engeland", "4x4"),
  route("Wales", "llanfihangel-uwch-gwili-halfway.gpx", "Llanfihangel Uwch Gwili Halfway", "Engeland", "4x4"),
  route(
    "Wales",
    "llanfihangel-geneur-glyn-dyffryn-castell.gpx",
    "Llanfihangel Geneur Glyn Dyffryn Castell",
    "Engeland",
    "4x4"
  ),
  route(
    "Wales",
    "lake-camp-spot-easy-morning-lanes-lunch-bastard-lane-and-pig.gpx",
    "Lake Camp Spot Easy Morning Lanes",
    "Engeland",
    "4x4"
  ),
  route("Wales", "goginan-pennal.gpx", "Goginan Pennal", "Engeland", "4x4"),
  route("Wales", "felingwmuchaf-llanfynydd.gpx", "Felingwmuchaf Llanfynydd", "Engeland", "4x4"),
  route("Wales", "dolanog-llanegryn.gpx", "Dolanog Llanegryn", "Engeland", "4x4"),
  route("Wales", "devils-bridge-mountain-trail.gpx", "Devils Bridge Mountain Trail", "Engeland", "4x4"),
  route("Wales", "ceredigion-loop.gpx", "Ceredigion Loop", "Engeland", "4x4"),
  route("Wales", "bwlch-nant-yr-arian-forest.gpx", "Bwlch Nant Yr Arian Forest", "Engeland", "4x4"),
  route("Wales", "brithdir-village-machynlleth.gpx", "Brithdir Village Machynlleth", "Engeland", "4x4"),
  route("Wales", "boulder-lane.gpx", "Boulder Lane", "Engeland", "4x4"),
  route("Wales", "abergwesyn-bryn-crug.gpx", "Abergwesyn Bryn Crug", "Engeland", "4x4"),
  route(
    "Hochsauerland",
    "t51666227_hochsauerland hoehenstrasse.gpx",
    "Hochsauerland Hoehenstrasse",
    "Duitsland",
    "roadtrip"
  ),
  route("Hochsauerland", "hochsauerland-dag-3-etap6.gpx", "Hochsauerland Dag 3 Etap 6", "Duitsland", "roadtrip"),
  route("Hochsauerland", "hochsauerland-dag-3-etap5.gpx", "Hochsauerland Dag 3 Etap 5", "Duitsland", "roadtrip"),
  route("Hochsauerland", "hochsauerland-dag-2-etap4.gpx", "Hochsauerland Dag 2 Etap 4", "Duitsland", "roadtrip"),
  route("Hochsauerland", "hochsauerland-dag-2-etap3.gpx", "Hochsauerland Dag 2 Etap 3", "Duitsland", "roadtrip"),
  route("Hochsauerland", "hochsauerland-dag-1b.gpx", "Hochsauerland Dag 1b", "Duitsland", "roadtrip"),
  route("Hochsauerland", "hochsauerland-dag-1a.gpx", "Hochsauerland Dag 1a", "Duitsland", "roadtrip")
];
