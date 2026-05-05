import { getSupabaseBrowserClient } from "@/lib/supabase";
import type { GpxRoute, RouteCountry, RoutePoint, RouteType, Waypoint } from "@/lib/types";

const ROUTE_COLORS = ["#f97316", "#0ea5e9", "#22c55e", "#e11d48", "#8b5cf6", "#14b8a6", "#f59e0b"];

type RouteRecord = {
  id: string;
  name: string;
  country: string | null;
  route_type: string | null;
  route_group: string | null;
  file_name: string | null;
  geojson: unknown;
  distance_km: number | string | null;
  elevation_gain_m: number | string | null;
  elevation_loss_m: number | string | null;
};

type LoadRoutesOptions = {
  tripId?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizeCountry(value: unknown): RouteCountry {
  return value === "Engeland" || value === "Duitsland" ? value : "Onbekend";
}

function normalizeRouteType(value: unknown): RouteType {
  return value === "roadtrip" ? "roadtrip" : "4x4";
}

function readPoint(value: unknown): RoutePoint | null {
  if (!isRecord(value)) return null;

  const lat = toNumber(value.lat);
  const lng = toNumber(value.lng);

  if (lat === undefined || lng === undefined) return null;

  return {
    lat,
    lng,
    ele: toNumber(value.ele),
    time: typeof value.time === "string" ? value.time : undefined
  };
}

function readPoints(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .map((point) => readPoint(point))
    .filter((point): point is RoutePoint => Boolean(point));
}

function readWaypoints(value: unknown): Waypoint[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((point) => {
      const parsed = readPoint(point);
      if (!parsed || !isRecord(point)) return null;

      return {
        ...parsed,
        name: typeof point.name === "string" && point.name.trim() ? point.name : "Waypoint"
      };
    })
    .filter((point): point is Waypoint => Boolean(point));
}

function readLineStringPoints(geojson: Record<string, unknown>): RoutePoint[] {
  const geometry = isRecord(geojson.geometry) ? geojson.geometry : null;
  const coordinates = Array.isArray(geometry?.coordinates) ? geometry.coordinates : [];

  return coordinates
    .map((coordinate) => {
      if (!Array.isArray(coordinate)) return null;
      const lng = toNumber(coordinate[0]);
      const lat = toNumber(coordinate[1]);
      const ele = toNumber(coordinate[2]);

      if (lat === undefined || lng === undefined) return null;

      const point: RoutePoint = { lat, lng };
      if (ele !== undefined) point.ele = ele;

      return point;
    })
    .filter((point): point is RoutePoint => Boolean(point));
}

function haversineKm(a: RoutePoint, b: RoutePoint) {
  const radiusKm = 6371;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const deltaLat = ((b.lat - a.lat) * Math.PI) / 180;
  const deltaLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const c = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return radiusKm * 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
}

function routeStats(points: RoutePoint[]) {
  let distanceKm = 0;
  let elevationGainM = 0;
  let elevationLossM = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    distanceKm += haversineKm(previous, current);

    if (previous.ele !== undefined && current.ele !== undefined) {
      const diff = current.ele - previous.ele;
      if (diff > 0) elevationGainM += diff;
      if (diff < 0) elevationLossM += Math.abs(diff);
    }
  }

  return { distanceKm, elevationGainM, elevationLossM };
}

function routeFromRecord(record: RouteRecord, index: number): GpxRoute | null {
  if (!isRecord(record.geojson)) return null;

  const properties = isRecord(record.geojson.properties) ? record.geojson.properties : {};
  const points = readPoints(properties.points);
  const routePoints = points.length > 1 ? points : readLineStringPoints(record.geojson);

  if (routePoints.length < 2) return null;

  const stats = routeStats(routePoints);

  return {
    id: record.id,
    name: record.name,
    source: "supabase",
    group: record.route_group ?? undefined,
    country: normalizeCountry(record.country),
    routeType: normalizeRouteType(record.route_type),
    fileName: record.file_name ?? undefined,
    color: ROUTE_COLORS[index % ROUTE_COLORS.length],
    points: routePoints,
    waypoints: readWaypoints(properties.waypoints),
    distanceKm: toNumber(record.distance_km) ?? stats.distanceKm,
    elevationGainM: toNumber(record.elevation_gain_m) ?? stats.elevationGainM,
    elevationLossM: toNumber(record.elevation_loss_m) ?? stats.elevationLossM
  };
}

async function routeIdsForTrip(tripId: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return [];

  const { data, error } = await supabase.from("trip_routes").select("route_id").eq("trip_id", tripId);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((record) => record.route_id).filter((routeId): routeId is string => Boolean(routeId));
}

export async function loadPublicSupabaseRoutes(options: LoadRoutesOptions = {}) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return [];

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return [];

  const tripRouteIds = options.tripId ? await routeIdsForTrip(options.tripId) : null;
  if (tripRouteIds && tripRouteIds.length === 0) return [];

  const { data, error } = await supabase
    .from("routes")
    .select("id,name,country,route_type,route_group,file_name,geojson,distance_km,elevation_gain_m,elevation_loss_m")
    .or(options.tripId ? `id.in.(${tripRouteIds!.join(",")})` : `is_public.eq.true,owner_id.eq.${user.id}`)
    .order("country", { ascending: true })
    .order("route_group", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as RouteRecord[])
    .map((record, index) => routeFromRecord(record, index))
    .filter((route): route is GpxRoute => Boolean(route));
}
