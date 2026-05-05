import { XMLParser } from "fast-xml-parser";

import type { GpxRoute, RouteCountry, RoutePoint, RouteType, Waypoint } from "./types";

const ROUTE_COLORS = ["#f97316", "#0ea5e9", "#22c55e", "#e11d48", "#8b5cf6", "#14b8a6", "#f59e0b"];

type ParseGpxOptions = {
  colorIndex?: number;
  group?: string;
  country?: RouteCountry;
  routeType?: RouteType;
};

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

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

function textValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (isRecord(value)) {
    const text = value["#text"];
    if (typeof text === "string" || typeof text === "number") return String(text).trim();
  }

  return "";
}

function fallbackName(fileName: string) {
  return fileName
    .replace(/\.gpx$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parsePoint(value: unknown): RoutePoint | null {
  if (!isRecord(value)) return null;

  const lat = toNumber(value.lat);
  const lng = toNumber(value.lon ?? value.lng);

  if (lat === undefined || lng === undefined) return null;

  return {
    lat,
    lng,
    ele: toNumber(value.ele),
    time: textValue(value.time) || undefined
  };
}

function routeStats(points: RoutePoint[]) {
  let distanceKm = 0;
  let elevationGainM = 0;
  let elevationLossM = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const radiusKm = 6371;
    const lat1 = (previous.lat * Math.PI) / 180;
    const lat2 = (current.lat * Math.PI) / 180;
    const deltaLat = ((current.lat - previous.lat) * Math.PI) / 180;
    const deltaLng = ((current.lng - previous.lng) * Math.PI) / 180;
    const sinLat = Math.sin(deltaLat / 2);
    const sinLng = Math.sin(deltaLng / 2);
    const c = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

    distanceKm += radiusKm * 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));

    if (previous.ele !== undefined && current.ele !== undefined) {
      const diff = current.ele - previous.ele;
      if (diff > 0) elevationGainM += diff;
      if (diff < 0) elevationLossM += Math.abs(diff);
    }
  }

  return { distanceKm, elevationGainM, elevationLossM };
}

export function parseGpxRoute(text: string, fileName: string, options: ParseGpxOptions = {}): GpxRoute {
  const parser = new XMLParser({
    attributeNamePrefix: "",
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    removeNSPrefix: true,
    trimValues: true
  });
  const parsed = parser.parse(text) as unknown;
  const root = isRecord(parsed) && isRecord(parsed.gpx) ? parsed.gpx : parsed;

  if (!isRecord(root)) {
    throw new Error("Dit GPX-bestand kon niet worden gelezen.");
  }

  const tracks = asArray(root.trk).filter(isRecord);
  const trackPoints = tracks.flatMap((track) =>
    asArray(track.trkseg)
      .filter(isRecord)
      .flatMap((segment) => asArray(segment.trkpt).map(parsePoint).filter((point): point is RoutePoint => Boolean(point)))
  );
  const routePoints = asArray(root.rte)
    .filter(isRecord)
    .flatMap((route) => asArray(route.rtept).map(parsePoint).filter((point): point is RoutePoint => Boolean(point)));
  const points = trackPoints.length > 0 ? trackPoints : routePoints;

  if (points.length < 2) {
    throw new Error("Er zijn te weinig routepunten in dit GPX-bestand.");
  }

  const waypoints: Waypoint[] = asArray(root.wpt)
    .map((point) => {
      const parsedPoint = parsePoint(point);
      if (!parsedPoint || !isRecord(point)) return null;

      return {
        ...parsedPoint,
        name: textValue(point.name) || "Waypoint"
      };
    })
    .filter((point): point is Waypoint => Boolean(point));

  const trackName = textValue(tracks[0]?.name);
  const metadataName = isRecord(root.metadata) ? textValue(root.metadata.name) : "";
  const name = trackName || metadataName || fallbackName(fileName);
  const stats = routeStats(points);
  const { colorIndex = 0, group = "Eigen offroad routes", country = "Onbekend", routeType = "4x4" } = options;

  return {
    id: `upload-${Date.now()}-${fileName}-${points.length}`,
    name,
    group,
    country,
    routeType,
    fileName,
    color: ROUTE_COLORS[colorIndex % ROUTE_COLORS.length],
    points,
    waypoints,
    ...stats
  };
}
