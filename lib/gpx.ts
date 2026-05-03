import type { GpxRoute, RouteCountry, RoutePoint, RouteType, Waypoint } from "@/lib/types";

const ROUTE_COLORS = ["#f97316", "#0ea5e9", "#22c55e", "#e11d48", "#8b5cf6"];

type ParseGpxOptions = {
  colorIndex?: number;
  group?: string;
  country?: RouteCountry;
  routeType?: RouteType;
};

function byLocalName(root: ParentNode, localName: string) {
  return Array.from(root.querySelectorAll("*")).filter(
    (node) => node.localName.toLowerCase() === localName.toLowerCase()
  );
}

function firstText(root: ParentNode, localName: string) {
  return byLocalName(root, localName)[0]?.textContent?.trim() ?? "";
}

function toNumber(value: string | null) {
  if (!value) return undefined;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
}

function parsePoint(node: Element): RoutePoint | null {
  const lat = toNumber(node.getAttribute("lat"));
  const lng = toNumber(node.getAttribute("lon"));

  if (lat === undefined || lng === undefined) {
    return null;
  }

  return {
    lat,
    lng,
    ele: toNumber(firstText(node, "ele")),
    time: firstText(node, "time") || undefined
  };
}

function haversineKm(a: RoutePoint, b: RoutePoint) {
  const radiusKm = 6371;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const deltaLat = ((b.lat - a.lat) * Math.PI) / 180;
  const deltaLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const c =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

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

  return {
    distanceKm,
    elevationGainM,
    elevationLossM
  };
}

function fallbackName(fileName: string) {
  return fileName
    .replace(/\.gpx$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function parseGpxRoute(
  text: string,
  fileName: string,
  source: GpxRoute["source"],
  options: ParseGpxOptions = {}
): GpxRoute {
  const {
    colorIndex = 0,
    group,
    country = "Onbekend",
    routeType = "4x4"
  } = options;
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, "application/xml");
  const parseError = byLocalName(xml, "parsererror")[0];

  if (parseError) {
    throw new Error("Dit GPX-bestand kon niet worden gelezen.");
  }

  const trackPoints = byLocalName(xml, "trkpt")
    .map((point) => parsePoint(point as Element))
    .filter((point): point is RoutePoint => Boolean(point));

  const routePoints = byLocalName(xml, "rtept")
    .map((point) => parsePoint(point as Element))
    .filter((point): point is RoutePoint => Boolean(point));

  const points = trackPoints.length > 0 ? trackPoints : routePoints;

  if (points.length < 2) {
    throw new Error("Er zijn te weinig routepunten in dit GPX-bestand.");
  }

  const waypoints: Waypoint[] = byLocalName(xml, "wpt")
    .map((point) => {
      const parsed = parsePoint(point as Element);
      if (!parsed) return null;

      return {
        ...parsed,
        name: firstText(point, "name") || "Waypoint"
      };
    })
    .filter((point): point is Waypoint => Boolean(point));

  const trackName = firstText(byLocalName(xml, "trk")[0] ?? xml, "name");
  const metadataName = firstText(byLocalName(xml, "metadata")[0] ?? xml, "name");
  const name = trackName || metadataName || fallbackName(fileName);
  const stats = routeStats(points);

  return {
    id: `${source}-${group ?? "route"}-${fileName}-${points.length}`,
    name,
    source,
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

export function formatKm(value: number) {
  return new Intl.NumberFormat("nl-NL", {
    maximumFractionDigits: value < 10 ? 1 : 0
  }).format(value);
}

export function formatMeters(value: number) {
  return new Intl.NumberFormat("nl-NL", {
    maximumFractionDigits: 0
  }).format(value);
}
