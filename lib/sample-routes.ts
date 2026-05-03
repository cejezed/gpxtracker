export type SampleRoute = {
  group: "Wales" | "Hochsauerland";
  fileName: string;
  title: string;
  url: string;
};

const route = (
  group: SampleRoute["group"],
  fileName: string,
  title: string
): SampleRoute => ({
  group,
  fileName,
  title,
  url: `/gpx/${group}/${encodeURIComponent(fileName)}`
});

export const sampleRoutes: SampleRoute[] = [
  route("Wales", "wales-2-day-4x4.gpx", "Wales 2 Day 4x4"),
  route("Wales", "tre-taliesin-goginan.gpx", "Tre Taliesin Goginan"),
  route("Wales", "the-wayfarer.gpx", "The Wayfarer"),
  route("Wales", "strata-florida.gpx", "Strata Florida"),
  route("Wales", "rocky-steps.gpx", "Rocky Steps"),
  route("Wales", "lost-lake.gpx", "Lost Lake"),
  route("Wales", "llwyngwril-arthog.gpx", "Llwyngwril Arthog"),
  route("Wales", "llanfihangel-uwch-gwili-halfway.gpx", "Llanfihangel Uwch Gwili Halfway"),
  route("Wales", "llanfihangel-geneur-glyn-dyffryn-castell.gpx", "Llanfihangel Geneur Glyn Dyffryn Castell"),
  route("Wales", "lake-camp-spot-easy-morning-lanes-lunch-bastard-lane-and-pig.gpx", "Lake Camp Spot Easy Morning Lanes"),
  route("Wales", "goginan-pennal.gpx", "Goginan Pennal"),
  route("Wales", "felingwmuchaf-llanfynydd.gpx", "Felingwmuchaf Llanfynydd"),
  route("Wales", "dolanog-llanegryn.gpx", "Dolanog Llanegryn"),
  route("Wales", "devils-bridge-mountain-trail.gpx", "Devils Bridge Mountain Trail"),
  route("Wales", "ceredigion-loop.gpx", "Ceredigion Loop"),
  route("Wales", "bwlch-nant-yr-arian-forest.gpx", "Bwlch Nant Yr Arian Forest"),
  route("Wales", "brithdir-village-machynlleth.gpx", "Brithdir Village Machynlleth"),
  route("Wales", "boulder-lane.gpx", "Boulder Lane"),
  route("Wales", "abergwesyn-bryn-crug.gpx", "Abergwesyn Bryn Crug"),
  route("Hochsauerland", "t51666227_hochsauerland hoehenstrasse.gpx", "Hochsauerland Hoehenstrasse"),
  route("Hochsauerland", "hochsauerland-dag-3-etap6.gpx", "Hochsauerland Dag 3 Etap 6"),
  route("Hochsauerland", "hochsauerland-dag-3-etap5.gpx", "Hochsauerland Dag 3 Etap 5"),
  route("Hochsauerland", "hochsauerland-dag-2-etap4.gpx", "Hochsauerland Dag 2 Etap 4"),
  route("Hochsauerland", "hochsauerland-dag-2-etap3.gpx", "Hochsauerland Dag 2 Etap 3"),
  route("Hochsauerland", "hochsauerland-dag-1b.gpx", "Hochsauerland Dag 1b"),
  route("Hochsauerland", "hochsauerland-dag-1a.gpx", "Hochsauerland Dag 1a")
];
