import type { RoutePoint } from "./types";

type OsrmRouteResponse = {
  code?: string;
  message?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: {
      type?: string;
      coordinates?: unknown;
    };
  }>;
};

export type RoadRouteResult = {
  points: RoutePoint[];
  distanceKm: number;
  durationMin?: number;
};

const DEFAULT_OSRM_BASE_URL = "https://router.project-osrm.org";

function osrmBaseUrl() {
  return (process.env.EXPO_PUBLIC_OSRM_BASE_URL ?? DEFAULT_OSRM_BASE_URL).replace(/\/+$/, "");
}

function readCoordinates(value: unknown): RoutePoint[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((coordinate) => {
      if (!Array.isArray(coordinate)) return null;

      const lng = coordinate[0];
      const lat = coordinate[1];

      if (typeof lat !== "number" || typeof lng !== "number") return null;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      return { lat, lng };
    })
    .filter((point): point is RoutePoint => Boolean(point));
}

export async function buildRoadRoute(points: RoutePoint[]): Promise<RoadRouteResult> {
  if (points.length < 2) {
    throw new Error("Minimaal twee punten nodig voor routing.");
  }

  const coordinates = points.map((point) => `${point.lng},${point.lat}`).join(";");
  const url = `${osrmBaseUrl()}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false&alternatives=false&generate_hints=false`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Routing server gaf HTTP ${response.status}.`);
  }

  const data = (await response.json()) as OsrmRouteResponse;
  const route = data.routes?.[0];
  const routePoints = readCoordinates(route?.geometry?.coordinates);

  if (data.code !== "Ok" || !route || routePoints.length < 2) {
    throw new Error(data.message ?? "Geen route over wegen gevonden.");
  }

  return {
    points: routePoints,
    distanceKm: typeof route.distance === "number" ? route.distance / 1000 : 0,
    durationMin: typeof route.duration === "number" ? route.duration / 60 : undefined
  };
}
