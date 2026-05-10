import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  Marker,
  type CameraRef,
  type MapRef,
  type PressEvent,
  type PressEventWithFeatures,
  type StyleSpecification,
  type ViewStateChangeEvent
} from "@maplibre/maplibre-react-native";
import type { RealtimeChannel, Session } from "@supabase/supabase-js";
import * as DocumentPicker from "expo-document-picker";
import * as Linking from "expo-linking";
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  type NativeSyntheticEvent,
  View
} from "react-native";

import { formatKm, formatMeters, loadPublicRoutes } from "./src/routes";
import { parseGpxRoute } from "./src/gpx";
import { buildRoadRoute } from "./src/routing";
import { isSupabaseConfigured, supabase } from "./src/supabase";
import type {
  GpsQuality,
  GpxRoute,
  MapPoint,
  MapPointType,
  RiderLocation,
  RouteCountry,
  RoutePoint,
  RouteType
} from "./src/types";

const TRIP_ID = "default-trip";
const GOOD_ACCURACY_M = 50;
const MODERATE_ACCURACY_M = 200;
const COUNTRIES: Array<"all" | RouteCountry> = ["all", "Engeland", "Duitsland"];
const REGION_ORDER = ["Lake District", "Wales", "Hoch Sauerland", "Eigen roadtrip routes", "Eigen offroad routes", "Opgenomen routes", "Overig"];
const MAP_POINT_TYPES: MapPointType[] = ["overnight", "fuel", "food", "viewpoint", "repair", "note"];

const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "OpenStreetMap contributors"
    }
  },
  layers: [
    {
      id: "osm",
      type: "raster",
      source: "osm"
    }
  ]
};

const DEFAULT_CENTER: [number, number] = [8.61388, 51.406776];

type PresenceLocation = {
  userId: string;
  name: string;
  lat: number;
  lng: number;
  speedKmh?: number;
  heading?: number;
  accuracyM?: number;
  color: string;
  updatedAt: string;
  gpsQuality?: GpsQuality;
};

type PlannerPoint = RoutePoint & {
  id: string;
  name: string;
};

type ActivePanel = "routes" | "plan" | "planner" | "record" | "manage";
type SheetMode = "compact" | "half" | "expanded";

type ActiveTrip = {
  id: string;
  name: string;
  shareCode: string;
};

type TripMember = {
  userId: string;
  email: string;
  role: string;
  createdAt: string;
};

type TripMemberRecord = {
  user_id: string;
  email: string;
  member_role: string;
  created_at: string;
};

type DayPlanItem = {
  id: string;
  routeId: string;
  startTime: string;
  breakMinutes: number;
  note: string;
};

type RouteGroupInfo = {
  country: RouteCountry;
  routeType: RouteType;
  group?: string;
  name?: string;
  fileName?: string;
};

function routeTypeLabel(routeType: RouteType) {
  return routeType === "roadtrip" ? "Roadtrip" : "Offroad";
}

function normalizeRegionName(group?: string, country?: RouteCountry) {
  const normalized = group?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";

  if (normalized.includes("lake district")) return "Lake District";
  if (normalized.includes("wales")) return "Wales";
  if (normalized.includes("hochsauerland") || normalized.includes("hoch sauerland")) return "Hoch Sauerland";
  if (country === "Duitsland") return "Hoch Sauerland";
  if (country === "Engeland") return "Wales";

  return group?.trim() || "Overig";
}

function routeGroupLabel(route: RouteGroupInfo) {
  return `${normalizeRegionName(route.group, route.country)} - ${routeTypeLabel(route.routeType)}`;
}

function sortGroupEntries<T>(entries: Array<[string, T[]]>) {
  return entries.sort(([a], [b]) => {
    const regionA = a.split(" - ")[0];
    const regionB = b.split(" - ")[0];
    const orderA = REGION_ORDER.indexOf(regionA);
    const orderB = REGION_ORDER.indexOf(regionB);
    const normalizedOrderA = orderA === -1 ? REGION_ORDER.length : orderA;
    const normalizedOrderB = orderB === -1 ? REGION_ORDER.length : orderB;

    if (normalizedOrderA !== normalizedOrderB) return normalizedOrderA - normalizedOrderB;
    return a.localeCompare(b, "nl");
  });
}

function routeMatchesFilters(
  route: RouteGroupInfo,
  query: string,
  countryFilter: "all" | RouteCountry,
  routeTypeFilter: "all" | RouteType
) {
  const haystack = `${route.country} ${route.group ?? ""} ${route.name ?? ""} ${route.fileName ?? ""} ${
    route.routeType
  }`.toLowerCase();

  return (
    haystack.includes(query.toLowerCase()) &&
    (countryFilter === "all" || route.country === countryFilter) &&
    (routeTypeFilter === "all" || route.routeType === routeTypeFilter)
  );
}

function mapPointLabel(type: MapPointType) {
  const labels: Record<MapPointType, string> = {
    overnight: "Overnachting",
    fuel: "Brandstof",
    food: "Eten",
    viewpoint: "Uitzicht",
    repair: "Service",
    note: "Notitie"
  };

  return labels[type];
}

function mapPointSymbol(type: MapPointType) {
  const symbols: Record<MapPointType, string> = {
    overnight: "O",
    fuel: "B",
    food: "E",
    viewpoint: "U",
    repair: "S",
    note: "N"
  };

  return symbols[type];
}

function mapPointColor(type: MapPointType) {
  const colors: Record<MapPointType, string> = {
    overnight: "#7c3aed",
    fuel: "#0ea5e9",
    food: "#16a34a",
    viewpoint: "#f97316",
    repair: "#475569",
    note: "#e11d48"
  };

  return colors[type];
}

function parseCoordinateInput(input: string) {
  const matches = Array.from(input.matchAll(/([NSEW])?\s*([+-]?\d+(?:[.,]\d+)?)\s*([NSEW])?/gi));

  if (matches.length < 2) return null;

  const values = matches.slice(0, 2).map((match) => {
    const direction = `${match[1] ?? ""}${match[3] ?? ""}`.toUpperCase();
    const numeric = Number.parseFloat(match[2].replace(",", "."));

    if (!Number.isFinite(numeric)) return Number.NaN;
    if (direction.includes("S") || direction.includes("W")) return -Math.abs(numeric);
    return numeric;
  });

  const [lat, lng] = values;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  return { lat, lng };
}

function formatCoordinate(lat: number, lng: number) {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function gpsQualityFromAccuracy(accuracyM?: number): GpsQuality {
  if (accuracyM === undefined) return "searching";
  if (accuracyM <= GOOD_ACCURACY_M) return "good";
  if (accuracyM <= MODERATE_ACCURACY_M) return "moderate";
  return "poor";
}

function gpsQualityLabel(quality: GpsQuality, accuracyM?: number) {
  const suffix = accuracyM === undefined ? "" : ` +/-${Math.round(accuracyM)} m`;

  if (quality === "good") return `GPS goed${suffix}`;
  if (quality === "moderate") return `GPS matig${suffix}`;
  if (quality === "poor") return `GPS zwak${suffix}`;
  return "GPS zoeken";
}

function markerColor(quality?: GpsQuality) {
  if (quality === "good") return "#2563eb";
  if (quality === "moderate") return "#f59e0b";
  if (quality === "poor") return "#6b7280";
  return "#94a3b8";
}

function routeBounds(points: RoutePoint[]) {
  return points.reduce(
    (bounds, point) => ({
      west: Math.min(bounds.west, point.lng),
      south: Math.min(bounds.south, point.lat),
      east: Math.max(bounds.east, point.lng),
      north: Math.max(bounds.north, point.lat)
    }),
    {
      west: Number.POSITIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY
    }
  );
}

function distanceMeters(a: Pick<RoutePoint, "lat" | "lng">, b: Pick<RoutePoint, "lat" | "lng">) {
  const radiusM = 6371000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const deltaLat = ((b.lat - a.lat) * Math.PI) / 180;
  const deltaLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const c = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return radiusM * 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
}

function bearingDegrees(a: Pick<RoutePoint, "lat" | "lng">, b: Pick<RoutePoint, "lat" | "lng">) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const deltaLng = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  return (Math.atan2(y, x) * 180) / Math.PI + 360;
}

function normalizeBearing(value: number) {
  return Math.round(value % 360);
}

function formatNavigationDistance(distanceM: number) {
  if (distanceM < 1000) return `${Math.round(distanceM)} m`;

  return `${new Intl.NumberFormat("nl-NL", {
    maximumFractionDigits: distanceM < 10000 ? 1 : 0
  }).format(distanceM / 1000)} km`;
}

function routeDistanceKm(points: RoutePoint[]) {
  let totalMeters = 0;

  for (let index = 1; index < points.length; index += 1) {
    totalMeters += distanceMeters(points[index - 1], points[index]);
  }

  return totalMeters / 1000;
}

function nearestRouteDistanceMeters(location: Pick<RoutePoint, "lat" | "lng">, route: GpxRoute | null) {
  if (!route || route.points.length === 0) return null;

  return route.points.reduce((nearest, point) => Math.min(nearest, distanceMeters(location, point)), Infinity);
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function routeToGpx(route: GpxRoute) {
  const waypoints = route.waypoints
    .map((point) => `  <wpt lat="${point.lat}" lon="${point.lng}"><name>${escapeXml(point.name)}</name></wpt>`)
    .join("\n");
  const trackPoints = route.points
    .map(
      (point) =>
        `      <trkpt lat="${point.lat}" lon="${point.lng}">${
          point.ele === undefined ? "" : `<ele>${point.ele}</ele>`
        }${point.time ? `<time>${escapeXml(point.time)}</time>` : ""}</trkpt>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RallyTrail" xmlns="http://www.topografix.com/GPX/1/1">
${waypoints ? `${waypoints}\n` : ""}  <trk>
    <name>${escapeXml(route.name)}</name>
    <trkseg>
${trackPoints}
    </trkseg>
  </trk>
</gpx>`;
}

function estimateRouteMinutes(route: GpxRoute) {
  const speedKmh = route.routeType === "roadtrip" ? 50 : 18;
  return Math.max(10, Math.round((route.distanceKm / speedKmh) * 60));
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  if (hours === 0) return `${remainder} min`;
  if (remainder === 0) return `${hours} u`;
  return `${hours} u ${remainder} min`;
}

function addMinutesToTime(time: string, minutes: number) {
  const [hours, rawMinutes] = time.split(":").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(hours) || !Number.isFinite(rawMinutes)) return "";

  const total = (hours * 60 + rawMinutes + minutes) % (24 * 60);
  const nextHours = Math.floor(total / 60);
  const nextMinutes = total % 60;

  return `${String(nextHours).padStart(2, "0")}:${String(nextMinutes).padStart(2, "0")}`;
}

function connectionDistanceKm(previous: GpxRoute, next: GpxRoute) {
  const previousEnd = previous.points[previous.points.length - 1];
  const nextStart = next.points[0];

  if (!previousEnd || !nextStart) return 0;
  return distanceMeters(previousEnd, nextStart) / 1000;
}

function orderByNearestConnection(routes: GpxRoute[]) {
  if (routes.length <= 2) return routes;

  const ordered = [routes[0]];
  const remaining = routes.slice(1);

  while (remaining.length > 0) {
    const previous = ordered[ordered.length - 1];
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    remaining.forEach((route, index) => {
      const distance = connectionDistanceKm(previous, route);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    const [nearest] = remaining.splice(nearestIndex, 1);
    ordered.push(nearest);
  }

  return ordered;
}

function routeLine(route: GpxRoute): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          id: route.id,
          name: route.name
        },
        geometry: {
          type: "LineString",
          coordinates: route.points.map((point) =>
            point.ele === undefined ? [point.lng, point.lat] : [point.lng, point.lat, point.ele]
          )
        }
      }
    ]
  };
}

function pointsLine(points: RoutePoint[], name: string): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name },
        geometry: {
          type: "LineString",
          coordinates: points.map((point) => [point.lng, point.lat])
        }
      }
    ]
  };
}

function connectionLines(routes: GpxRoute[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  for (let index = 1; index < routes.length; index += 1) {
    const previous = routes[index - 1];
    const current = routes[index];
    const previousEnd = previous.points[previous.points.length - 1];
    const currentStart = current.points[0];

    if (!previousEnd || !currentStart) continue;

    features.push({
      type: "Feature",
      properties: {
        id: `${previous.id}-${current.id}`,
        distanceKm: connectionDistanceKm(previous, current)
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [previousEnd.lng, previousEnd.lat],
          [currentStart.lng, currentStart.lat]
        ]
      }
    });
  }

  return {
    type: "FeatureCollection",
    features
  };
}

function routeGeoJson(route: GpxRoute): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: {
      points: route.points,
      waypoints: route.waypoints,
      pointCount: route.points.length,
      elevationGainM: Math.round(route.elevationGainM),
      elevationLossM: Math.round(route.elevationLossM),
      sourceFile: route.fileName ?? "waypoint-route"
    },
    geometry: {
      type: "LineString",
      coordinates: route.points.map((point) =>
        point.ele === undefined ? [point.lng, point.lat] : [point.lng, point.lat, point.ele]
      )
    }
  };
}

function buildWaypointRoute(
  points: PlannerPoint[],
  routeType: RouteType,
  routedPoints: RoutePoint[],
  distanceKm = routeDistanceKm(routedPoints)
): GpxRoute {
  const stamp = new Date();
  const routeLabel = routeType === "roadtrip" ? "Roadtrip route" : "Offroad waypoint route";

  return {
    id: `waypoint-${stamp.getTime()}`,
    name: `${routeLabel} ${stamp.toLocaleDateString("nl-NL")}`,
    group: routeType === "roadtrip" ? "Eigen roadtrip routes" : "Eigen offroad routes",
    country: "Onbekend",
    routeType,
    fileName: routeType === "roadtrip" ? "waypoint-roadtrip-route" : "waypoint-offroad-route",
    color: routeType === "roadtrip" ? "#0ea5e9" : "#f97316",
    points: routedPoints,
    waypoints: points.map(({ lat, lng, name }) => ({ lat, lng, name })),
    distanceKm,
    elevationGainM: 0,
    elevationLossM: 0
  };
}

function buildRecordedRoute(points: RoutePoint[], routeType: RouteType, startedAt: string | null): GpxRoute {
  const stamp = startedAt ? new Date(startedAt) : new Date();
  const dateLabel = `${stamp.toLocaleDateString("nl-NL")} ${stamp.toLocaleTimeString("nl-NL", {
    hour: "2-digit",
    minute: "2-digit"
  })}`;
  const first = points[0];
  const last = points[points.length - 1];

  return {
    id: `recording-${Date.now()}`,
    name: `Opgenomen ${routeTypeLabel(routeType)} ${dateLabel}`,
    group: "Opgenomen routes",
    country: "Onbekend",
    routeType,
    fileName: "recorded-track",
    color: "#e11d48",
    points,
    waypoints: [
      ...(first ? [{ ...first, name: "Start opname" }] : []),
      ...(last ? [{ ...last, name: "Einde opname" }] : [])
    ],
    distanceKm: routeDistanceKm(points),
    elevationGainM: 0,
    elevationLossM: 0
  };
}

function parseAuthParams(url: string) {
  const [baseAndQuery, fragment = ""] = url.split("#");
  const query = baseAndQuery.includes("?") ? baseAndQuery.split("?")[1] : "";
  return new URLSearchParams([query, fragment].filter(Boolean).join("&"));
}

function normalizeTripMembers(data: unknown): TripMember[] {
  if (!Array.isArray(data)) return [];

  return (data as TripMemberRecord[])
    .filter((member) => member.user_id && member.email)
    .map((member) => ({
      userId: member.user_id,
      email: member.email,
      role: member.member_role,
      createdAt: member.created_at
    }));
}

async function loadTripMembers(tripId: string) {
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("list_trip_members", { p_trip_id: tripId });
  if (error) throw new Error(error.message);

  return normalizeTripMembers(data);
}

export default function App() {
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [routes, setRoutes] = useState<GpxRoute[]>([]);
  const [dayPlanItems, setDayPlanItems] = useState<DayPlanItem[]>([]);
  const [mapPoints, setMapPoints] = useState<MapPoint[]>([]);
  const [pointType, setPointType] = useState<MapPointType>("overnight");
  const [pointName, setPointName] = useState("Overnachting");
  const [pointCoordinates, setPointCoordinates] = useState("");
  const [pointNote, setPointNote] = useState("");
  const [pointError, setPointError] = useState<string | null>(null);
  const [mapPickMode, setMapPickMode] = useState(false);
  const [overviewRouteIds, setOverviewRouteIds] = useState<string[]>([]);
  const [activeTrip, setActiveTrip] = useState<ActiveTrip | null>(null);
  const [tripCodeInput, setTripCodeInput] = useState("");
  const [tripMessage, setTripMessage] = useState<string | null>(null);
  const [tripMembers, setTripMembers] = useState<TripMember[]>([]);
  const [tripMembersLoading, setTripMembersLoading] = useState(false);
  const [memberEmail, setMemberEmail] = useState("");
  const [manageMessage, setManageMessage] = useState<string | null>(null);
  const [routeVisibilitySaving, setRouteVisibilitySaving] = useState<string | null>(null);
  const [countryFilter, setCountryFilter] = useState<"all" | RouteCountry>("all");
  const [routeTypeFilter, setRouteTypeFilter] = useState<"all" | RouteType>("all");
  const [query, setQuery] = useState("");
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [gpxImporting, setGpxImporting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("Rijder");
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [ownLocation, setOwnLocation] = useState<RiderLocation | null>(null);
  const [remoteRiders, setRemoteRiders] = useState<RiderLocation[]>([]);
  const [locationMessage, setLocationMessage] = useState("GPS starten...");
  const [activePanel, setActivePanel] = useState<ActivePanel>("routes");
  const [sheetMode, setSheetMode] = useState<SheetMode>("half");
  const [livePanelOpen, setLivePanelOpen] = useState(false);
  const [rideMode, setRideMode] = useState(false);
  const [followOwnLocation, setFollowOwnLocation] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(9);
  const [activeRouteDetailsOpen, setActiveRouteDetailsOpen] = useState(false);
  const [expandedRouteGroups, setExpandedRouteGroups] = useState<Record<string, boolean>>({});
  const [plannerEnabled, setPlannerEnabled] = useState(false);
  const [plannerPoints, setPlannerPoints] = useState<PlannerPoint[]>([]);
  const [plannerRouteType, setPlannerRouteType] = useState<RouteType>("roadtrip");
  const [plannerSaving, setPlannerSaving] = useState(false);
  const [plannerRouteMessage, setPlannerRouteMessage] = useState<string | null>(null);
  const [targetWaypointIndex, setTargetWaypointIndex] = useState(0);
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingRouteType, setRecordingRouteType] = useState<RouteType>("4x4");
  const [recordingStartedAt, setRecordingStartedAt] = useState<string | null>(null);
  const [recordedPoints, setRecordedPoints] = useState<RoutePoint[]>([]);
  const [recordingSaving, setRecordingSaving] = useState(false);
  const [recordingMessage, setRecordingMessage] = useState<string | null>(null);

  const activeRoute = useMemo(
    () => routes.find((route) => route.id === activeRouteId) ?? routes[0] ?? null,
    [activeRouteId, routes]
  );

  const routeMap = useMemo(() => new Map(routes.map((route) => [route.id, route])), [routes]);

  const filteredRoutes = useMemo(
    () => routes.filter((route) => routeMatchesFilters(route, query, countryFilter, routeTypeFilter)),
    [countryFilter, query, routeTypeFilter, routes]
  );

  const groupedRoutes = useMemo(() => {
    return filteredRoutes.reduce<Record<string, GpxRoute[]>>((groups, route) => {
      const label = routeGroupLabel(route);
      groups[label] = [...(groups[label] ?? []), route];
      return groups;
    }, {});
  }, [filteredRoutes]);

  const sortedRouteGroups = useMemo(() => sortGroupEntries(Object.entries(groupedRoutes)), [groupedRoutes]);

  const activeRouteGroup = activeRoute ? routeGroupLabel(activeRoute) : null;

  const plannedRoutes = useMemo(
    () =>
      dayPlanItems
        .map((item) => routeMap.get(item.routeId))
        .filter((route): route is GpxRoute => Boolean(route)),
    [dayPlanItems, routeMap]
  );

  const overviewRoutes = useMemo(
    () =>
      overviewRouteIds
        .map((routeId) => routeMap.get(routeId))
        .filter((route): route is GpxRoute => Boolean(route)),
    [overviewRouteIds, routeMap]
  );

  const visibleMapRoutes = useMemo(() => {
    if (activePanel === "plan" && plannedRoutes.length > 0) return plannedRoutes;
    if (overviewRoutes.length > 0) return overviewRoutes;
    return activeRoute ? [activeRoute] : [];
  }, [activePanel, activeRoute, overviewRoutes, plannedRoutes]);

  const visibleConnectionLine = useMemo(
    () => (visibleMapRoutes.length > 1 ? connectionLines(visibleMapRoutes) : null),
    [visibleMapRoutes]
  );

  const plannerLine = useMemo(
    () => (plannerPoints.length > 1 ? pointsLine(plannerPoints, "Waypoint route") : null),
    [plannerPoints]
  );

  const plannerDistanceKm = useMemo(() => routeDistanceKm(plannerPoints), [plannerPoints]);

  const recordedDistanceKm = useMemo(() => routeDistanceKm(recordedPoints), [recordedPoints]);

  const recordedLine = useMemo(
    () => (recordedPoints.length > 1 ? pointsLine(recordedPoints, "Opgenomen route") : null),
    [recordedPoints]
  );

  const routeTypeCounts = useMemo(
    () => ({
      "4x4": routes.filter((route) => route.routeType === "4x4").length,
      roadtrip: routes.filter((route) => route.routeType === "roadtrip").length
    }),
    [routes]
  );

  const planStats = useMemo(() => {
    const driveMinutes = plannedRoutes.reduce((total, route) => total + estimateRouteMinutes(route), 0);
    const breakMinutes = dayPlanItems.reduce((total, item) => total + item.breakMinutes, 0);

    return {
      distanceKm: plannedRoutes.reduce((total, route) => total + route.distanceKm, 0),
      elevationGainM: plannedRoutes.reduce((total, route) => total + route.elevationGainM, 0),
      driveMinutes,
      breakMinutes,
      totalMinutes: driveMinutes + breakMinutes
    };
  }, [dayPlanItems, plannedRoutes]);

  const overviewConnections = useMemo(
    () =>
      overviewRoutes.slice(1).map((route, index) => {
        const previous = overviewRoutes[index];
        return {
          id: `${previous.id}-${route.id}`,
          from: previous.name,
          to: route.name,
          distanceKm: connectionDistanceKm(previous, route)
        };
      }),
    [overviewRoutes]
  );

  const overviewStats = useMemo(
    () => ({
      routeDistanceKm: overviewRoutes.reduce((total, route) => total + route.distanceKm, 0),
      connectionDistanceKm: overviewConnections.reduce((total, connection) => total + connection.distanceKm, 0)
    }),
    [overviewConnections, overviewRoutes]
  );

  const navigationWaypoints = useMemo(() => {
    if (!activeRoute) return [];
    if (activeRoute.waypoints.length > 0) return activeRoute.waypoints;

    const first = activeRoute.points[0];
    const last = activeRoute.points[activeRoute.points.length - 1];
    if (!first || !last) return [];

    return [
      { ...first, name: "Start" },
      { ...last, name: "Finish" }
    ];
  }, [activeRoute]);

  const safeTargetWaypointIndex = Math.min(targetWaypointIndex, Math.max(navigationWaypoints.length - 1, 0));
  const targetWaypoint = navigationWaypoints[safeTargetWaypointIndex] ?? null;

  const targetDistanceM = useMemo(() => {
    if (!ownLocation || !targetWaypoint) return null;
    return distanceMeters(ownLocation, targetWaypoint);
  }, [ownLocation, targetWaypoint]);

  const targetBearing = useMemo(() => {
    if (!ownLocation || !targetWaypoint) return null;
    return normalizeBearing(bearingDegrees(ownLocation, targetWaypoint));
  }, [ownLocation, targetWaypoint]);

  const offRouteDistanceM = useMemo(
    () => (ownLocation ? nearestRouteDistanceMeters(ownLocation, activeRoute) : null),
    [activeRoute, ownLocation]
  );
  const offRouteWarning = rideMode && offRouteDistanceM !== null && offRouteDistanceM > 75;
  const shouldFollowOwnLocation = rideMode || followOwnLocation;

  const addPlannerPoint = useCallback((lat: number, lng: number) => {
    setPlannerPoints((current) => [
      ...current,
      {
        id: `planner-${Date.now()}-${current.length}`,
        name: `Punt ${current.length + 1}`,
        lat,
        lng
      }
    ]);
    setActivePanel("planner");
    setSheetMode("half");
  }, []);

  const handleMapPress = useCallback(
    (event: NativeSyntheticEvent<PressEvent | PressEventWithFeatures>) => {
      const [lng, lat] = event.nativeEvent.lngLat;

      if (plannerEnabled) {
        addPlannerPoint(lat, lng);
        return;
      }

      if (mapPickMode) {
        setMapPoints((current) => [
          ...current,
          {
            id: `point-${Date.now()}-${current.length}`,
            name: pointName.trim() || mapPointLabel(pointType),
            type: pointType,
            lat,
            lng,
            note: pointNote.trim() || undefined,
            source: "manual"
          }
        ]);
        setPointCoordinates(formatCoordinate(lat, lng));
        setPointError(null);
        setMapPickMode(false);
        setActivePanel("plan");
        setSheetMode("half");
      }
    },
    [addPlannerPoint, mapPickMode, plannerEnabled, pointName, pointNote, pointType]
  );

  const refreshRoutes = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setRouteError("Supabase is nog niet ingesteld voor de native app.");
      return;
    }

    if (!session?.user && activeTrip) {
      setRoutes([]);
      setOverviewRouteIds([]);
      setActiveRouteId(null);
      setRouteError(null);
      return;
    }

    setRoutesLoading(true);
    setRouteError(null);

    try {
      const publicRoutes = await loadPublicRoutes({ tripId: activeTrip?.id });
      setRoutes(publicRoutes);
      setActiveRouteId((current) => current ?? publicRoutes[0]?.id ?? null);
      setOverviewRouteIds((current) => current.filter((routeId) => publicRoutes.some((route) => route.id === routeId)));
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Routes laden is mislukt.");
    } finally {
      setRoutesLoading(false);
    }
  }, [activeTrip?.id, session?.user]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshRoutes();
    }, 0);

    return () => clearTimeout(timer);
  }, [refreshRoutes]);

  useEffect(() => {
    let cancelled = false;

    async function refreshTripMembers() {
      if (!session?.user || !activeTrip) {
        setTripMembers([]);
        setTripMembersLoading(false);
        return;
      }

      setTripMembersLoading(true);
      try {
        const members = await loadTripMembers(activeTrip.id);
        if (!cancelled) setTripMembers(members);
      } catch (error) {
        if (!cancelled) {
          setManageMessage(error instanceof Error ? error.message : "Leden konden niet worden geladen.");
        }
      } finally {
        if (!cancelled) setTripMembersLoading(false);
      }
    }

    void refreshTripMembers();

    return () => {
      cancelled = true;
    };
  }, [activeTrip, session?.user]);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
      if (!nextSession) setRemoteRiders([]);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleAuthUrl = useCallback(async (url: string) => {
    if (!supabase) return;

    const params = parseAuthParams(url);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const code = params.get("code");

    if (accessToken && refreshToken) {
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      setAuthMessage(error ? error.message : "Ingelogd.");
      return;
    }

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      setAuthMessage(error ? error.message : "Ingelogd.");
    }
  }, []);

  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      if (url) void handleAuthUrl(url);
    });

    const subscription = Linking.addEventListener("url", ({ url }) => {
      void handleAuthUrl(url);
    });

    return () => subscription.remove();
  }, [handleAuthUrl]);

  const handleLocation = useCallback(
    (location: Location.LocationObject) => {
      const accuracyM =
        typeof location.coords.accuracy === "number" && Number.isFinite(location.coords.accuracy)
          ? location.coords.accuracy
          : undefined;
      const quality = gpsQualityFromAccuracy(accuracyM);
      const userId = session?.user.id ?? "local-user";
      const nextLocation: RiderLocation = {
        userId,
        name: displayName.trim() || "Rijder",
        lat: location.coords.latitude,
        lng: location.coords.longitude,
        speedKmh:
          typeof location.coords.speed === "number" && location.coords.speed !== null
            ? Math.max(0, location.coords.speed * 3.6)
            : undefined,
        heading:
          typeof location.coords.heading === "number" && location.coords.heading !== null
            ? location.coords.heading
            : undefined,
        accuracyM,
        color: "#2563eb",
        updatedAt: new Date(location.timestamp).toISOString(),
        isSelf: true,
        gpsQuality: quality
      };

      setOwnLocation(nextLocation);
      setLocationMessage(gpsQualityLabel(quality, accuracyM));

      if (recordingActive) {
        if (quality !== "good") {
          setRecordingMessage("Opname wacht op GPS goed.");
          return;
        }

        const recordedPoint: RoutePoint = {
          lat: location.coords.latitude,
          lng: location.coords.longitude,
          ele:
            typeof location.coords.altitude === "number" && Number.isFinite(location.coords.altitude)
              ? location.coords.altitude
              : undefined,
          time: nextLocation.updatedAt
        };

        setRecordingMessage(null);
        setRecordedPoints((current) => {
          const previous = current[current.length - 1];
          if (previous && distanceMeters(previous, recordedPoint) < 5) return current;

          return [...current, recordedPoint];
        });
      }
    },
    [displayName, recordingActive, session?.user.id]
  );

  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    async function startLocation() {
      const permission = await Location.requestForegroundPermissionsAsync();

      if (permission.status !== "granted") {
        setLocationMessage("GPS toestemming ontbreekt.");
        return;
      }

      try {
        setLocationMessage("GPS zoekt nauwkeurige fix...");
        const current = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.BestForNavigation
        });
        if (!cancelled) handleLocation(current);
      } catch {
        if (!cancelled) setLocationMessage("GPS zoekt nog naar signaal.");
      }

      subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 2000,
          distanceInterval: 3,
          mayShowUserSettingsDialog: true
        },
        (nextLocation) => {
          if (!cancelled) handleLocation(nextLocation);
        }
      );
    }

    void startLocation();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [handleLocation]);

  useEffect(() => {
    const client = supabase;
    if (!client || !session?.user) {
      return;
    }

    let active = true;
    const channel = client.channel(`trip:${activeTrip?.id ?? TRIP_ID}`, {
      config: {
        presence: {
          key: session.user.id
        }
      }
    });
    channelRef.current = channel;

    channel.on("presence", { event: "sync" }, () => {
      if (!active) return;
      const state = channel.presenceState<PresenceLocation>();
      const riders = Object.entries(state).flatMap(([key, presences]) =>
        presences.map((presence) => ({
          userId: presence.userId ?? key,
          name: presence.name,
          lat: presence.lat,
          lng: presence.lng,
          speedKmh: presence.speedKmh,
          heading: presence.heading,
          accuracyM: presence.accuracyM,
          updatedAt: presence.updatedAt,
          color: presence.color,
          gpsQuality: presence.gpsQuality,
          isSelf: key === session.user.id
        }))
      );

      setRemoteRiders(riders.filter((rider) => rider.userId !== session.user.id));
    });

    channel.subscribe();

    return () => {
      active = false;
      channel.untrack();
      client.removeChannel(channel);
      channelRef.current = null;
    };
  }, [activeTrip?.id, session]);

  useEffect(() => {
    if (!channelRef.current || !session?.user || !ownLocation || ownLocation.gpsQuality !== "good") return;

    channelRef.current.track({
      userId: session.user.id,
      name: displayName.trim() || "Rijder",
      lat: ownLocation.lat,
      lng: ownLocation.lng,
      speedKmh: ownLocation.speedKmh,
      heading: ownLocation.heading,
      accuracyM: ownLocation.accuracyM,
      updatedAt: ownLocation.updatedAt,
      color: ownLocation.color,
      gpsQuality: ownLocation.gpsQuality
    } satisfies PresenceLocation);
  }, [displayName, ownLocation, session?.user]);

  useEffect(() => {
    if (visibleMapRoutes.length === 0 || !cameraRef.current || (shouldFollowOwnLocation && ownLocation)) return;

    const bounds = routeBounds(visibleMapRoutes.flatMap((route) => route.points));
    if (!Number.isFinite(bounds.west) || !Number.isFinite(bounds.south)) return;

    const bottomPadding = sheetMode === "compact" ? 140 : sheetMode === "half" ? 340 : 610;

    cameraRef.current.fitBounds([bounds.west, bounds.south, bounds.east, bounds.north], {
      padding: { top: 120, right: 48, bottom: bottomPadding, left: 48 },
      duration: 700,
      easing: "ease"
    });
  }, [ownLocation, sheetMode, shouldFollowOwnLocation, visibleMapRoutes]);

  useEffect(() => {
    if (!shouldFollowOwnLocation || !ownLocation || mapPickMode || plannerEnabled) return;

    const minimumZoom = ownLocation.gpsQuality === "good" ? 15 : 13;
    cameraRef.current?.easeTo({
      center: [ownLocation.lng, ownLocation.lat],
      zoom: Math.max(zoomLevel, minimumZoom),
      duration: 450,
      easing: "ease"
    });
  }, [
    mapPickMode,
    ownLocation,
    ownLocation?.gpsQuality,
    plannerEnabled,
    shouldFollowOwnLocation,
    zoomLevel
  ]);

  async function handleMagicLink() {
    if (!supabase || !email.trim()) return;

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: Linking.createURL("auth")
      }
    });

    setAuthMessage(error ? error.message : "Magic link verstuurd.");
  }

  async function handlePasswordSignIn() {
    if (!supabase || !email.trim() || !password) return;

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password
    });

    setAuthMessage(error ? error.message : "Ingelogd.");
  }

  async function handlePasswordSignUp() {
    if (!supabase || !email.trim() || password.length < 6) {
      setAuthMessage("Gebruik een e-mailadres en een wachtwoord van minimaal 6 tekens.");
      return;
    }

    const { error } = await supabase.auth.signUp({
      email: email.trim(),
      password
    });

    setAuthMessage(error ? error.message : "Account gemaakt. Je bent ingelogd of moet je e-mail nog bevestigen.");
  }

  async function handleSignOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setActiveTrip(null);
    setTripMembers([]);
    setRoutes([]);
    setOverviewRouteIds([]);
    setActiveRouteId(null);
  }

  async function createTrip() {
    if (!supabase || !session?.user) return;

    setTripMessage("Groepsrit maken...");
    const { data, error } = await supabase
      .from("trips")
      .insert({
        owner_id: session.user.id,
        name: `Groepsrit ${new Date().toLocaleDateString("nl-NL")}`,
        active: true
      })
      .select("id,name,share_code")
      .single();

    if (error) {
      setTripMessage(error.message);
      return;
    }

    await supabase.from("trip_members").upsert(
      {
        trip_id: data.id,
        user_id: session.user.id,
        role: "owner"
      },
      { onConflict: "trip_id,user_id", ignoreDuplicates: true }
    );

    setActiveTrip({ id: data.id, name: data.name, shareCode: data.share_code });
    setTripCodeInput(data.share_code);
    setTripMessage(`Groepsrit actief. Code: ${data.share_code}`);
    setRoutes([]);
    setOverviewRouteIds([]);
    setActiveRouteId(null);
  }

  async function joinTrip() {
    if (!supabase || !session?.user) return;

    const code = tripCodeInput.trim().toUpperCase();
    if (!code) return;

    setTripMessage("Groepsrit openen...");
    const { data, error } = await supabase
      .from("trips")
      .select("id,name,share_code")
      .eq("share_code", code)
      .eq("active", true)
      .single();

    if (error || !data) {
      setTripMessage(error?.message ?? "Groepsrit niet gevonden.");
      return;
    }

    const { error: memberError } = await supabase.from("trip_members").upsert(
      {
        trip_id: data.id,
        user_id: session.user.id,
        role: "rider"
      },
      { onConflict: "trip_id,user_id", ignoreDuplicates: true }
    );

    if (memberError) {
      setTripMessage(memberError.message);
      return;
    }

    setActiveTrip({ id: data.id, name: data.name, shareCode: data.share_code });
    setTripMessage("Groepsrit actief. Alleen routes van deze rit worden getoond.");
    setRoutes([]);
    setOverviewRouteIds([]);
    setActiveRouteId(null);
  }

  function leaveTrip() {
    setActiveTrip(null);
    setTripMembers([]);
    setManageMessage(null);
    setTripMessage("Groepsrit verlaten.");
    setRoutes([]);
    setOverviewRouteIds([]);
    setActiveRouteId(null);
  }

  async function refreshTripMemberList() {
    if (!activeTrip) return;

    setTripMembersLoading(true);
    try {
      setTripMembers(await loadTripMembers(activeTrip.id));
    } catch (error) {
      setManageMessage(error instanceof Error ? error.message : "Leden konden niet worden geladen.");
    } finally {
      setTripMembersLoading(false);
    }
  }

  async function addTripMemberByEmail() {
    if (!supabase || !activeTrip || !memberEmail.trim()) return;

    const trimmedEmail = memberEmail.trim();
    setManageMessage("Lid toevoegen...");
    const { error } = await supabase.rpc("add_trip_member_by_email", {
      p_trip_id: activeTrip.id,
      p_email: trimmedEmail,
      p_role: "rider"
    });

    if (error) {
      setManageMessage(error.message);
      return;
    }

    setMemberEmail("");
    setManageMessage(`${trimmedEmail} heeft toegang tot deze groepsrit.`);
    await refreshTripMemberList();
  }

  async function removeTripMemberByEmail(emailToRemove: string) {
    if (!supabase || !activeTrip) return;

    setManageMessage("Lid verwijderen...");
    const { error } = await supabase.rpc("remove_trip_member_by_email", {
      p_trip_id: activeTrip.id,
      p_email: emailToRemove
    });

    if (error) {
      setManageMessage(error.message);
      return;
    }

    setManageMessage(`${emailToRemove} heeft geen toegang meer tot deze groepsrit.`);
    await refreshTripMemberList();
  }

  async function toggleRouteVisibility(route: GpxRoute) {
    if (!supabase || !session?.user) return;

    const nextIsPublic = !(route.isPublic ?? false);
    setRouteVisibilitySaving(route.id);
    setManageMessage(nextIsPublic ? "Route publiek maken..." : "Route afschermen...");

    const { error } = await supabase.from("routes").update({ is_public: nextIsPublic }).eq("id", route.id);

    if (error) {
      setManageMessage(error.message);
      setRouteVisibilitySaving(null);
      return;
    }

    setRoutes((current) =>
      current.map((currentRoute) =>
        currentRoute.id === route.id ? { ...currentRoute, isPublic: nextIsPublic } : currentRoute
      )
    );
    setManageMessage(nextIsPublic ? "Route is publiek zichtbaar." : "Route is prive.");
    setRouteVisibilitySaving(null);
  }

  async function exportActiveRoute() {
    if (!activeRoute) return;

    await Share.share({
      title: `${activeRoute.name}.gpx`,
      message: routeToGpx(activeRoute)
    });
  }

  function centerOnOwnLocation() {
    if (!ownLocation) {
      Alert.alert("Geen GPS", "RallyTrail heeft nog geen locatie ontvangen.");
      return;
    }

    const nextFollow = rideMode ? true : !followOwnLocation;
    setFollowOwnLocation(nextFollow);
    cameraRef.current?.easeTo({
      center: [ownLocation.lng, ownLocation.lat],
      zoom: ownLocation.gpsQuality === "good" ? 15 : 13,
      duration: 500,
      easing: "ease"
    });
  }

  async function changeZoom(delta: number) {
    const currentZoom = await mapRef.current?.getZoom().catch(() => zoomLevel);
    const nextZoom = Math.max(3, Math.min(19, (currentZoom ?? zoomLevel) + delta));
    setZoomLevel(nextZoom);
    cameraRef.current?.zoomTo(nextZoom, { duration: 180, easing: "ease" });
  }

  function openPanel(panel: ActivePanel) {
    setActivePanel(panel);
    setLivePanelOpen(false);

    if (panel !== "plan") {
      setMapPickMode(false);
    }

    if (panel !== "planner") {
      setPlannerEnabled(false);
    }

    if (sheetMode === "compact") {
      setSheetMode("half");
    }
  }

  function cycleSheetMode() {
    setSheetMode((current) => (current === "compact" ? "half" : current === "half" ? "expanded" : "compact"));
  }

  function toggleRouteGroup(group: string) {
    setExpandedRouteGroups((current) => ({
      ...current,
      [group]: !(current[group] ?? group === activeRouteGroup)
    }));
  }

  function selectRoute(route: GpxRoute) {
    setActiveRouteId(route.id);
    setTargetWaypointIndex(0);
    setExpandedRouteGroups((current) => ({ ...current, [routeGroupLabel(route)]: true }));
  }

  function isRouteInOverview(routeId: string) {
    return overviewRouteIds.includes(routeId);
  }

  function toggleRouteInOverview(route: GpxRoute) {
    setOverviewRouteIds((current) =>
      current.includes(route.id) ? current.filter((routeId) => routeId !== route.id) : [...current, route.id]
    );
    selectRoute(route);
  }

  function selectVisibleRoutesForOverview() {
    setOverviewRouteIds((current) => {
      const next = [...current];

      filteredRoutes.forEach((route) => {
        if (!next.includes(route.id)) next.push(route.id);
      });

      return next;
    });

    if (filteredRoutes[0]) {
      selectRoute(filteredRoutes[0]);
    }

    setSheetMode("compact");
  }

  function sortOverviewByNearest() {
    setOverviewRouteIds(orderByNearestConnection(overviewRoutes).map((route) => route.id));
  }

  function suggestedStartTime(currentItems: DayPlanItem[]) {
    if (currentItems.length === 0) return "09:00";

    const lastItem = currentItems[currentItems.length - 1];
    const lastRoute = routeMap.get(lastItem.routeId);
    if (!lastRoute || !lastItem.startTime) return "";

    return addMinutesToTime(lastItem.startTime, estimateRouteMinutes(lastRoute) + lastItem.breakMinutes);
  }

  function addRoutesToPlan(routesToAdd: GpxRoute[]) {
    if (routesToAdd.length === 0) return;

    setDayPlanItems((current) => {
      const next = [...current];

      routesToAdd.forEach((route, index) => {
        if (next.some((item) => item.routeId === route.id)) return;

        next.push({
          id: `plan-${route.id}-${Date.now()}-${index}`,
          routeId: route.id,
          startTime: suggestedStartTime(next),
          breakMinutes: next.length === 0 ? 0 : 15,
          note: ""
        });
      });

      return next;
    });

    selectRoute(routesToAdd[0]);
    setActivePanel("plan");
    setSheetMode("half");
  }

  function addRouteToPlan(route: GpxRoute) {
    addRoutesToPlan([route]);
  }

  function addOverviewToPlan() {
    addRoutesToPlan(overviewRoutes);
  }

  function updatePlanItem(itemId: string, patch: Partial<DayPlanItem>) {
    setDayPlanItems((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
  }

  function movePlanItem(itemId: string, direction: -1 | 1) {
    setDayPlanItems((current) => {
      const index = current.findIndex((item) => item.id === itemId);
      const targetIndex = index + direction;

      if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return current;

      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(targetIndex, 0, item);
      return next;
    });
  }

  function removePlanItem(itemId: string) {
    setDayPlanItems((current) => current.filter((item) => item.id !== itemId));
  }

  function buildPointName() {
    return pointName.trim() || mapPointLabel(pointType);
  }

  function addMapPoint(point: Omit<MapPoint, "id">) {
    setMapPoints((current) => [
      ...current,
      {
        ...point,
        id: `point-${Date.now()}-${current.length}`
      }
    ]);
    setPointError(null);
    setMapPickMode(false);
    setActivePanel("plan");
    setSheetMode("half");
  }

  function toggleMapPickMode() {
    setActivePanel("plan");
    setPlannerEnabled(false);
    setMapPickMode((current) => !current);
    setSheetMode("compact");
  }

  function addPointAtOwnLocation() {
    if (!ownLocation) {
      Alert.alert("Geen GPS", "RallyTrail heeft nog geen locatie ontvangen.");
      return;
    }

    addMapPoint({
      name: buildPointName(),
      type: pointType,
      lat: ownLocation.lat,
      lng: ownLocation.lng,
      note: pointNote.trim() || (ownLocation.accuracyM ? `GPS +/-${Math.round(ownLocation.accuracyM)} m` : undefined),
      source: "own-location"
    });
  }

  function addPointAtRouteEnd() {
    const lastPoint = activeRoute?.points[activeRoute.points.length - 1];
    if (!lastPoint) {
      Alert.alert("Geen route", "Selecteer eerst een route.");
      return;
    }

    addMapPoint({
      name: buildPointName(),
      type: pointType,
      lat: lastPoint.lat,
      lng: lastPoint.lng,
      note: pointNote.trim() || `Eindpunt ${activeRoute.name}`,
      source: "route-end"
    });
  }

  function addPointFromCoordinates() {
    const parsed = parseCoordinateInput(pointCoordinates);

    if (!parsed) {
      setPointError("Gebruik bijvoorbeeld: 52.196562, -3.749340");
      return;
    }

    addMapPoint({
      name: buildPointName(),
      type: pointType,
      lat: parsed.lat,
      lng: parsed.lng,
      note: pointNote.trim() || undefined,
      source: "manual"
    });
  }

  function fillCoordinatesFromOwnLocation() {
    if (!ownLocation) return;
    setPointCoordinates(formatCoordinate(ownLocation.lat, ownLocation.lng));
  }

  function fillCoordinatesFromRouteEnd() {
    const lastPoint = activeRoute?.points[activeRoute.points.length - 1];
    if (!lastPoint) return;
    setPointCoordinates(formatCoordinate(lastPoint.lat, lastPoint.lng));
  }

  function removeMapPoint(pointId: string) {
    setMapPoints((current) => current.filter((point) => point.id !== pointId));
  }

  function addOwnLocationAsPoint() {
    if (!ownLocation) {
      Alert.alert("Geen GPS", "RallyTrail heeft nog geen locatie ontvangen.");
      return;
    }

    addPlannerPoint(ownLocation.lat, ownLocation.lng);
  }

  function removeLastPlannerPoint() {
    setPlannerPoints((current) => current.slice(0, -1));
  }

  function clearPlannerPoints() {
    setPlannerPoints([]);
  }

  async function saveRoute(route: GpxRoute) {
    if (!supabase || !session?.user) return route;

    const { data, error } = await supabase
      .from("routes")
      .insert({
        owner_id: session.user.id,
        name: route.name,
        country: route.country,
        route_type: route.routeType,
        route_group: route.group,
        file_name: route.fileName,
        geojson: routeGeoJson(route),
        distance_km: Number(route.distanceKm.toFixed(3)),
        elevation_gain_m: Math.round(route.elevationGainM),
        elevation_loss_m: Math.round(route.elevationLossM),
        is_public: !activeTrip
      })
      .select("id")
      .single();

    if (error) throw error;

    if (activeTrip) {
      const { error: tripRouteError } = await supabase.from("trip_routes").upsert({
        trip_id: activeTrip.id,
        route_id: data.id,
        added_by: session.user.id
      });

      if (tripRouteError) throw tripRouteError;
    }

    return {
      ...route,
      id: data.id,
      isPublic: !activeTrip
    };
  }

  async function createWaypointRoute() {
    if (plannerPoints.length < 2) {
      Alert.alert("Meer punten nodig", "Voeg minimaal twee punten toe voor een waypoint route.");
      return;
    }

    setPlannerSaving(true);
    setPlannerRouteMessage(plannerRouteType === "roadtrip" ? "Route over wegen berekenen..." : "Offroad route maken...");
    try {
      const directPoints = plannerPoints.map(({ lat, lng }) => ({ lat, lng }));
      const roadRoute = plannerRouteType === "roadtrip" ? await buildRoadRoute(directPoints) : null;
      const draftRoute = buildWaypointRoute(
        plannerPoints,
        plannerRouteType,
        roadRoute?.points ?? directPoints,
        roadRoute?.distanceKm
      );
      const route = await saveRoute(draftRoute);

      setRoutes((current) => [route, ...current]);
      setOverviewRouteIds((current) => (current.includes(route.id) ? current : [route.id, ...current]));
      setActiveRouteId(route.id);
      setTargetWaypointIndex(0);
      setPlannerPoints([]);
      setPlannerEnabled(false);
      setActivePanel("planner");
      setPlannerRouteMessage(
        plannerRouteType === "roadtrip"
          ? `Wegenroute gemaakt (${formatKm(route.distanceKm)} km).`
          : `Offroad route gemaakt (${formatKm(route.distanceKm)} km).`
      );
    } catch (error) {
      setPlannerRouteMessage(null);
      Alert.alert(
        "Route maken mislukt",
        error instanceof Error ? error.message : "De route kon niet worden aangemaakt."
      );
    } finally {
      setPlannerSaving(false);
    }
  }

  async function importGpxFile() {
    setRouteError(null);
    setGpxImporting(true);

    try {
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: ["application/gpx+xml", "application/xml", "text/xml", "application/octet-stream", "*/*"]
      });

      if (picked.canceled) return;

      const asset = picked.assets[0];
      if (!asset?.uri) throw new Error("Geen GPX-bestand gekozen.");

      const response = await fetch(asset.uri);
      const text = await response.text();
      const draftRoute = parseGpxRoute(text, asset.name || "route.gpx", {
        colorIndex: routes.length,
        group: activeTrip ? "Groepsrit route" : "Eigen offroad routes",
        country: "Onbekend",
        routeType: "4x4"
      });
      const route = await saveRoute(draftRoute);

      setRoutes((current) => [route, ...current]);
      setOverviewRouteIds((current) => (current.includes(route.id) ? current : [route.id, ...current]));
      selectRoute(route);
      setExpandedRouteGroups((current) => ({ ...current, [routeGroupLabel(route)]: true }));
      setSheetMode("half");
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "GPX import is mislukt.");
    } finally {
      setGpxImporting(false);
    }
  }

  function startRecording() {
    setRecordingActive(true);
    setRecordingStartedAt((current) => current ?? new Date().toISOString());
    setRecordingMessage("Opname gestart. Punten worden vastgelegd bij GPS goed.");
    setActivePanel("record");
  }

  function pauseRecording() {
    setRecordingActive(false);
    setRecordingMessage("Opname gepauzeerd.");
  }

  function resetRecording() {
    setRecordingActive(false);
    setRecordingStartedAt(null);
    setRecordedPoints([]);
    setRecordingMessage(null);
  }

  async function saveRecordingRoute() {
    if (recordedPoints.length < 2) {
      Alert.alert("Te weinig punten", "Rij eerst een stukje met goede GPS voordat je de opname opslaat.");
      return;
    }

    setRecordingSaving(true);
    setRecordingMessage("Opname opslaan...");
    try {
      const draftRoute = buildRecordedRoute(recordedPoints, recordingRouteType, recordingStartedAt);
      const route = await saveRoute(draftRoute);

      setRoutes((current) => [route, ...current]);
      setOverviewRouteIds((current) => (current.includes(route.id) ? current : [route.id, ...current]));
      setActiveRouteId(route.id);
      setTargetWaypointIndex(0);
      setRecordingActive(false);
      setRecordingStartedAt(null);
      setRecordedPoints([]);
      setRecordingMessage(`Opname opgeslagen (${formatKm(route.distanceKm)} km).`);
      setActivePanel("record");
    } catch (error) {
      setRecordingMessage(null);
      Alert.alert(
        "Opslaan mislukt",
        error instanceof Error ? error.message : "De opname kon niet worden opgeslagen."
      );
    } finally {
      setRecordingSaving(false);
    }
  }

  function goToPreviousWaypoint() {
    setTargetWaypointIndex((current) => Math.max(0, current - 1));
  }

  function goToNextWaypoint() {
    setTargetWaypointIndex((current) => Math.min(navigationWaypoints.length - 1, current + 1));
  }

  const routeCount = routes.length;
  const visibleRemoteRiders = session?.user ? remoteRiders : [];
  const liveCount = visibleRemoteRiders.length + (ownLocation ? 1 : 0);
  const gpsNeedsAttention = !ownLocation || ownLocation.gpsQuality !== "good";
  const sheetSummary = activeRoute
    ? {
        title: activeRoute.name,
        detail: `${formatKm(activeRoute.distanceKm)} km | ${activeRoute.country} | ${routeTypeLabel(activeRoute.routeType)}`
      }
    : {
        title:
          activePanel === "routes"
            ? "Routes"
            : activePanel === "plan"
              ? "Dagschema"
              : activePanel === "planner"
                ? "Route maken"
                : activePanel === "manage"
                  ? "Beheer"
                  : "Opname",
        detail:
          activePanel === "manage"
            ? activeTrip
              ? `${tripMembers.length} leden | ${routeCount} routes`
              : "Geen groepsrit actief"
            : activePanel === "plan"
            ? `${dayPlanItems.length} etappes | ${mapPoints.length} punten`
            : activePanel === "planner"
              ? `${plannerPoints.length} waypoints | ${formatKm(plannerDistanceKm)} km direct`
              : activePanel === "record"
                ? `${recordedPoints.length} punten | ${formatKm(recordedDistanceKm)} km`
                : `${routeCount} routes`
      };

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <MapLibreMap
        ref={mapRef}
        style={styles.map}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution
        attributionPosition={{ bottom: 10, right: 10 }}
        compassPosition={{ top: 88, right: 16 }}
        onPress={handleMapPress}
        onRegionDidChange={(event: NativeSyntheticEvent<ViewStateChangeEvent>) => setZoomLevel(event.nativeEvent.zoom)}
      >
        <Camera ref={cameraRef} initialViewState={{ center: DEFAULT_CENTER, zoom: 9 }} />

        {visibleMapRoutes.map((route, index) => {
          const isActive = route.id === activeRoute?.id || (!activeRoute && index === 0);

          return (
            <GeoJSONSource key={`${route.id}-${index}`} id={`route-${index}`} data={routeLine(route)}>
              <Layer
                id={`route-${index}-shadow`}
                type="line"
                style={{
                  lineColor: "#111827",
                  lineOpacity: isActive ? 0.72 : 0.32,
                  lineWidth: isActive ? 8 : 5,
                  lineCap: "round",
                  lineJoin: "round"
                }}
              />
              <Layer
                id={`route-${index}-line`}
                type="line"
                style={{
                  lineColor: route.color,
                  lineOpacity: isActive ? 1 : 0.66,
                  lineWidth: isActive ? 4 : 3,
                  lineCap: "round",
                  lineJoin: "round"
                }}
              />
            </GeoJSONSource>
          );
        })}

        {visibleConnectionLine ? (
          <GeoJSONSource id="route-connections" data={visibleConnectionLine}>
            <Layer
              id="route-connections-line"
              type="line"
              style={{
                lineColor: "#111827",
                lineOpacity: 0.46,
                lineWidth: 2,
                lineDasharray: [2, 2]
              }}
            />
          </GeoJSONSource>
        ) : null}

        {plannerLine ? (
          <GeoJSONSource id="planner-route" data={plannerLine}>
            <Layer
              id="planner-route-line"
              type="line"
              style={{
                lineColor: "#0f766e",
                lineOpacity: 0.9,
                lineWidth: 4,
                lineCap: "round",
                lineJoin: "round"
              }}
            />
          </GeoJSONSource>
        ) : null}

        {recordedLine ? (
          <GeoJSONSource id="recorded-route" data={recordedLine}>
            <Layer
              id="recorded-route-line"
              type="line"
              style={{
                lineColor: "#e11d48",
                lineOpacity: 0.95,
                lineWidth: 4,
                lineCap: "round",
                lineJoin: "round"
              }}
            />
          </GeoJSONSource>
        ) : null}

        {navigationWaypoints.map((waypoint, index) => {
          const isTarget = index === safeTargetWaypointIndex;
          return (
            <Marker
              key={`${activeRoute?.id ?? "route"}-${index}-${waypoint.name}`}
              id={`route-waypoint-${activeRoute?.id ?? "route"}-${index}`}
              lngLat={[waypoint.lng, waypoint.lat]}
            >
              <View style={[styles.waypointMarker, isTarget && styles.targetWaypointMarker]}>
                <Text style={[styles.waypointMarkerText, isTarget && styles.targetWaypointText]}>{index + 1}</Text>
              </View>
            </Marker>
          );
        })}

        {plannerPoints.map((point, index) => (
          <Marker key={point.id} id={point.id} lngLat={[point.lng, point.lat]}>
            <View style={styles.plannerMarker}>
              <Text style={styles.plannerMarkerText}>{index + 1}</Text>
            </View>
          </Marker>
        ))}

        {mapPoints.map((point, index) => (
          <Marker key={point.id} id={point.id} lngLat={[point.lng, point.lat]}>
            <View style={[styles.mapPointMarker, { backgroundColor: mapPointColor(point.type) }]}>
              <Text style={styles.mapPointMarkerText}>{mapPointSymbol(point.type)}</Text>
              <Text style={styles.mapPointIndex}>{index + 1}</Text>
            </View>
          </Marker>
        ))}

        {ownLocation ? (
          <Marker id="own-location" lngLat={[ownLocation.lng, ownLocation.lat]}>
            <View
              style={[
                styles.ownMarker,
                {
                  borderColor: markerColor(ownLocation.gpsQuality),
                  backgroundColor: `${markerColor(ownLocation.gpsQuality)}33`
                }
              ]}
            >
              <View style={[styles.ownMarkerCore, { backgroundColor: markerColor(ownLocation.gpsQuality) }]} />
            </View>
          </Marker>
        ) : null}

        {visibleRemoteRiders.map((rider) => (
          <Marker key={rider.userId} id={`rider-${rider.userId}`} lngLat={[rider.lng, rider.lat]}>
            <View style={[styles.riderMarker, { backgroundColor: rider.color || "#14b8a6" }]}>
              <Text style={styles.riderMarkerText}>{rider.name.slice(0, 1).toUpperCase()}</Text>
            </View>
          </Marker>
        ))}
      </MapLibreMap>

      <View style={styles.topBar}>
        <View style={styles.topInfo}>
          <Text style={styles.appName}>RallyTrail</Text>
          <Text style={styles.statusText} numberOfLines={1}>
            {routeCount} routes | {gpsQualityLabel(ownLocation?.gpsQuality ?? "searching", ownLocation?.accuracyM)} |{" "}
            {liveCount} live
            {recordingActive ? ` | REC ${formatKm(recordedDistanceKm)} km` : ""}
          </Text>
        </View>
        <View style={styles.topActions}>
          <Pressable
            style={[styles.rideButton, rideMode && styles.rideButtonActive, !activeRoute && styles.disabledButton]}
            disabled={!activeRoute}
            onPress={() => {
              setRideMode((current) => {
                const nextRideMode = !current;
                setFollowOwnLocation(nextRideMode);
                if (nextRideMode) setSheetMode("compact");
                return nextRideMode;
              });
            }}
          >
            <Text style={[styles.rideButtonText, rideMode && styles.rideButtonTextActive]}>Rij</Text>
          </Pressable>
          <Pressable
            style={[styles.recordButton, recordingActive && styles.recordButtonActive]}
            onPress={() => {
              if (recordingActive) {
                pauseRecording();
              } else {
                startRecording();
                setSheetMode("half");
              }
            }}
          >
            <Text style={[styles.recordButtonText, recordingActive && styles.recordButtonTextActive]}>
              {recordingActive ? "Stop" : "Rec"}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.planButton, plannerEnabled && styles.planButtonActive]}
            onPress={() => {
              const nextEnabled = !plannerEnabled;
              setPlannerEnabled(nextEnabled);
              setMapPickMode(false);
              setLivePanelOpen(false);
              setActivePanel("planner");
              setSheetMode(nextEnabled ? "compact" : "half");
            }}
          >
            <Text style={[styles.planButtonText, plannerEnabled && styles.planButtonTextActive]}>Plan</Text>
          </Pressable>
          <Pressable
            style={[styles.liveButton, livePanelOpen && styles.liveButtonActive]}
            onPress={() => {
              setLivePanelOpen((current) => !current);
              if (sheetMode === "compact") setSheetMode("half");
            }}
          >
            <Text style={[styles.liveButtonText, livePanelOpen && styles.liveButtonTextActive]}>Live</Text>
          </Pressable>
          <Pressable
            style={[styles.locationButton, shouldFollowOwnLocation && styles.locationButtonActive]}
            onPress={centerOnOwnLocation}
          >
            <Text style={[styles.locationButtonText, shouldFollowOwnLocation && styles.locationButtonTextActive]}>
              {shouldFollowOwnLocation ? "Volg" : "GPS"}
            </Text>
          </Pressable>
        </View>
      </View>

      {gpsNeedsAttention ? (
        <View style={styles.gpsBadge}>
          <Text style={[styles.gpsBadgeText, { color: markerColor(ownLocation?.gpsQuality) }]}>{locationMessage}</Text>
          <Text style={styles.gpsBadgeSub}>Live delen start bij GPS goed ({GOOD_ACCURACY_M} m of beter).</Text>
        </View>
      ) : null}

      {(mapPickMode || plannerEnabled) && (
        <View style={styles.mapModeBadge}>
          <Text style={styles.mapModeText}>
            {plannerEnabled ? "Tik op de kaart voor waypoints" : `${mapPointLabel(pointType)} plaatsen`}
          </Text>
          <Pressable
            style={styles.mapModeCancel}
            onPress={() => {
              setMapPickMode(false);
              setPlannerEnabled(false);
            }}
          >
            <Text style={styles.mapModeCancelText}>Stop</Text>
          </Pressable>
        </View>
      )}

      {rideMode && activeRoute ? (
        <View style={[styles.rideOverlay, offRouteWarning && styles.rideOverlayWarning]}>
          <Text style={[styles.rideOverlayTitle, offRouteWarning && styles.rideOverlayTitleWarning]}>
            {offRouteWarning ? "Van route" : "Rijmodus"}
          </Text>
          <Text style={styles.rideOverlayText}>
            {offRouteDistanceM === null
              ? "Wachten op GPS"
              : offRouteDistanceM < 1000
                ? `${Math.round(offRouteDistanceM)} m van route`
                : `${formatKm(offRouteDistanceM / 1000)} km van route`}
          </Text>
          <Text style={styles.rideOverlayText}>
            {ownLocation?.speedKmh === undefined ? locationMessage : `${Math.round(ownLocation.speedKmh)} km/u`}
          </Text>
        </View>
      ) : null}

      <View style={styles.zoomControls}>
        <Pressable style={styles.zoomButton} onPress={() => void changeZoom(1)}>
          <Text style={styles.zoomButtonText}>+</Text>
        </Pressable>
        <Pressable style={styles.zoomButton} onPress={() => void changeZoom(-1)}>
          <Text style={styles.zoomButtonText}>-</Text>
        </Pressable>
      </View>

      {livePanelOpen ? (
        <View style={styles.liveOverlay}>
          <View style={styles.liveOverlayHeader}>
            <Text style={styles.liveOverlayTitle}>Live groep</Text>
            <Pressable style={styles.closeButton} onPress={() => setLivePanelOpen(false)}>
              <Text style={styles.closeButtonText}>x</Text>
            </Pressable>
          </View>
          {session?.user ? (
            <>
              <Text style={styles.mutedText}>Ingelogd als {session.user.email ?? "rijder"}</Text>
              <TextInput
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="Naam op de kaart"
                placeholderTextColor="#6b7280"
                style={styles.input}
              />
              <Pressable style={styles.secondaryButton} onPress={handleSignOut}>
                <Text style={styles.secondaryButtonText}>Uitloggen</Text>
              </Pressable>
              <View style={styles.tripBox}>
                <Text style={styles.routeName}>{activeTrip ? activeTrip.name : "Geen groepsrit actief"}</Text>
                <Text style={styles.routeSub}>
                  {activeTrip
                    ? `Code ${activeTrip.shareCode} | alleen routes van deze rit`
                    : "Maak of open een ritcode voor afgeschermde routes."}
                </Text>
                <TextInput
                  value={tripCodeInput}
                  onChangeText={(text) => setTripCodeInput(text.toUpperCase())}
                  placeholder="Ritcode"
                  placeholderTextColor="#6b7280"
                  autoCapitalize="characters"
                  style={styles.input}
                />
                <View style={styles.actionGrid}>
                  <Pressable style={styles.secondaryButton} onPress={createTrip}>
                    <Text style={styles.secondaryButtonText}>Nieuw</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.secondaryButton, !tripCodeInput.trim() && styles.disabledButton]}
                    disabled={!tripCodeInput.trim()}
                    onPress={joinTrip}
                  >
                    <Text style={styles.secondaryButtonText}>Join</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.secondaryButton, !activeTrip && styles.disabledButton]}
                    disabled={!activeTrip}
                    onPress={leaveTrip}
                  >
                    <Text style={styles.secondaryButtonText}>Uit</Text>
                  </Pressable>
                </View>
                {tripMessage ? <Text style={styles.mutedText}>{tripMessage}</Text> : null}
              </View>
            </>
          ) : (
            <>
              <Text style={styles.mutedText}>Publieke routes werken zonder login. Login is nodig voor groepsritten en live delen.</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="email@example.com"
                placeholderTextColor="#6b7280"
                style={styles.input}
              />
              <TextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="Wachtwoord"
                placeholderTextColor="#6b7280"
                style={styles.input}
              />
              <View style={styles.actionGrid}>
                <Pressable
                  style={[styles.primaryButton, (!isSupabaseConfigured || !email.trim() || !password) && styles.disabledButton]}
                  disabled={!isSupabaseConfigured || !email.trim() || !password}
                  onPress={handlePasswordSignIn}
                >
                  <Text style={styles.primaryButtonText}>Login</Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.secondaryButton,
                    (!isSupabaseConfigured || !email.trim() || password.length < 6) && styles.disabledButton
                  ]}
                  disabled={!isSupabaseConfigured || !email.trim() || password.length < 6}
                  onPress={handlePasswordSignUp}
                >
                  <Text style={styles.secondaryButtonText}>Nieuw</Text>
                </Pressable>
              </View>
              <Pressable
                style={[styles.secondaryButton, (!isSupabaseConfigured || !email.trim()) && styles.disabledButton]}
                disabled={!isSupabaseConfigured || !email.trim()}
                onPress={handleMagicLink}
              >
                <Text style={styles.secondaryButtonText}>Stuur magic link</Text>
              </Pressable>
            </>
          )}
          {authMessage ? <Text style={styles.mutedText}>{authMessage}</Text> : null}
          <View style={styles.riderList}>
            {[ownLocation, ...visibleRemoteRiders].filter(Boolean).map((rider) => (
              <Text key={rider!.userId} style={styles.mutedText}>
                {rider!.name} | {gpsQualityLabel(rider!.gpsQuality ?? "searching", rider!.accuracyM)}
              </Text>
            ))}
          </View>
        </View>
      ) : null}

      <View
        style={[
          styles.sheet,
          sheetMode === "compact" && styles.sheetCompact,
          sheetMode === "half" && styles.sheetHalf,
          sheetMode === "expanded" && styles.sheetExpanded
        ]}
      >
        <View style={styles.sheetHeader}>
          <Pressable style={styles.sheetHandle} onPress={cycleSheetMode}>
            <View style={styles.sheetGrip} />
            <View style={styles.sheetSummary}>
              <Text style={styles.sheetSummaryTitle} numberOfLines={1}>
                {sheetSummary.title}
              </Text>
              <Text style={styles.sheetSummaryDetail} numberOfLines={1}>
                {sheetSummary.detail}
              </Text>
            </View>
          </Pressable>
          <View style={styles.sheetActions}>
            <Pressable style={styles.sheetActionButton} onPress={() => setSheetMode("compact")}>
              <Text style={styles.sheetActionText}>Kaart</Text>
            </Pressable>
            <Pressable
              style={styles.sheetActionButton}
              onPress={() => setSheetMode((current) => (current === "expanded" ? "half" : "expanded"))}
            >
              <Text style={styles.sheetActionText}>{sheetMode === "expanded" ? "Half" : "Groot"}</Text>
            </Pressable>
          </View>
        </View>

        {sheetMode !== "compact" ? (
          <>
            <View style={styles.panelTabs}>
              {(["routes", "plan", "planner", "record", "manage"] as ActivePanel[]).map((panel) => (
            <Pressable
              key={panel}
              style={[styles.panelTab, activePanel === panel && styles.panelTabActive]}
              onPress={() => openPanel(panel)}
            >
              <Text style={[styles.panelTabText, activePanel === panel && styles.panelTabTextActive]}>
                {panel === "routes"
                  ? "Routes"
                  : panel === "plan"
                    ? "Dag"
                    : panel === "planner"
                      ? "Maken"
                      : panel === "record"
                        ? "Opname"
                        : "Beheer"}
              </Text>
            </Pressable>
              ))}
            </View>

            <ScrollView
              refreshControl={<RefreshControl refreshing={routesLoading} onRefresh={refreshRoutes} />}
              showsVerticalScrollIndicator={false}
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetContent}
            >
              {activePanel === "routes" ? (
                <>
                  <View style={styles.sectionHeader}>
                    <View>
                      <Text style={styles.sectionTitle}>Routebibliotheek</Text>
                      <Text style={styles.mutedText}>
                        {filteredRoutes.length} van {routeCount} routes
                      </Text>
                    </View>
                    <View style={styles.headerActions}>
                      {routesLoading || gpxImporting ? <ActivityIndicator color="#f97316" /> : null}
                      <Pressable
                        style={[styles.compactButton, gpxImporting && styles.disabledButton]}
                        disabled={gpxImporting}
                        onPress={importGpxFile}
                      >
                        <Text style={styles.compactButtonText}>{gpxImporting ? "..." : "GPX"}</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.compactButton, !activeRoute && styles.disabledButton]}
                        disabled={!activeRoute}
                        onPress={() => void exportActiveRoute()}
                      >
                        <Text style={styles.compactButtonText}>Delen</Text>
                      </Pressable>
                    </View>
                  </View>

                  {routeError ? <Text style={styles.errorText}>{routeError}</Text> : null}

                  {!session?.user ? (
                    <View style={styles.lockedPanel}>
                      <Text style={styles.routeName}>Testmodus</Text>
                      <Text style={styles.routeSub}>
                        Publieke routes zijn zichtbaar zonder login. Login is alleen nodig voor groepsritten, prive-routes en beheer.
                      </Text>
                    </View>
                  ) : null}

                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Zoek route"
                    placeholderTextColor="#6b7280"
                    style={styles.searchInput}
                  />

                  <View style={styles.filterGrid}>
                    {(["4x4", "roadtrip"] as RouteType[]).map((type) => {
                      const selected = routeTypeFilter === type;
                      return (
                        <Pressable
                          key={type}
                          style={[styles.filterCard, selected && styles.filterCardActive]}
                          onPress={() => setRouteTypeFilter((current) => (current === type ? "all" : type))}
                        >
                          <Text style={[styles.filterCardTitle, selected && styles.filterCardTitleActive]}>
                            {routeTypeLabel(type)}
                          </Text>
                          <Text style={[styles.filterCardMeta, selected && styles.filterCardMetaActive]}>
                            {routeTypeCounts[type]} routes
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <View style={styles.segmentedRow}>
                    {COUNTRIES.map((country) => {
                      const selected = countryFilter === country;
                      return (
                        <Pressable
                          key={country}
                          style={[styles.segmentButton, selected && styles.segmentButtonActive]}
                          onPress={() => setCountryFilter(country)}
                        >
                          <Text style={[styles.segmentButtonText, selected && styles.segmentButtonTextActive]}>
                            {country === "all" ? "Alle landen" : country}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <View style={styles.overviewCard}>
                    <View style={styles.overviewHeader}>
                      <View style={styles.routeTextBlock}>
                        <Text style={styles.overviewTitle}>Overzicht op kaart</Text>
                        <Text style={styles.routeSub}>
                          {overviewRoutes.length} routes | {formatKm(overviewStats.routeDistanceKm)} km
                          {overviewStats.connectionDistanceKm > 0
                            ? ` | ${formatKm(overviewStats.connectionDistanceKm)} km verbinding`
                            : ""}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.actionGrid}>
                      <Pressable
                        style={[styles.secondaryButton, filteredRoutes.length === 0 && styles.disabledButton]}
                        disabled={filteredRoutes.length === 0}
                        onPress={selectVisibleRoutesForOverview}
                      >
                        <Text style={styles.secondaryButtonText}>Toon alles</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.secondaryButton, overviewRoutes.length < 3 && styles.disabledButton]}
                        disabled={overviewRoutes.length < 3}
                        onPress={sortOverviewByNearest}
                      >
                        <Text style={styles.secondaryButtonText}>Sorteer</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.primaryButton, overviewRoutes.length === 0 && styles.disabledButton]}
                        disabled={overviewRoutes.length === 0}
                        onPress={addOverviewToPlan}
                      >
                        <Text style={styles.primaryButtonText}>Naar dag</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.secondaryButton, overviewRoutes.length === 0 && styles.disabledButton]}
                        disabled={overviewRoutes.length === 0}
                        onPress={() => setOverviewRouteIds([])}
                      >
                        <Text style={styles.secondaryButtonText}>Wis</Text>
                      </Pressable>
                    </View>
                    {overviewConnections.length > 0 ? (
                      <View style={styles.connectionList}>
                        {overviewConnections.map((connection, index) => (
                          <Text key={connection.id} style={styles.routeSub}>
                            {index + 1}. {formatKm(connection.distanceKm)} km naar volgende route
                          </Text>
                        ))}
                      </View>
                    ) : null}
                  </View>

                  {activeRoute ? (
                    <>
                      <Pressable
                        style={styles.activeRouteSummary}
                        onPress={() => setActiveRouteDetailsOpen((current) => !current)}
                      >
                        <View style={[styles.routeColor, { backgroundColor: activeRoute.color }]} />
                        <View style={styles.routeTextBlock}>
                          <Text style={styles.routeName} numberOfLines={1}>
                            {activeRoute.name}
                          </Text>
                          <Text style={styles.routeSub}>
                            {routeTypeLabel(activeRoute.routeType)} | {formatKm(activeRoute.distanceKm)} km | details
                          </Text>
                        </View>
                        <Text style={styles.routeActionText}>{activeRouteDetailsOpen ? "-" : "+"}</Text>
                      </Pressable>
                      {activeRouteDetailsOpen ? (
                        <View style={styles.activeCard}>
                          <Text style={styles.routeType}>{routeTypeLabel(activeRoute.routeType)}</Text>
                          <Text style={styles.activeRouteName}>{activeRoute.name}</Text>
                          <Text style={styles.routeMeta}>
                            {normalizeRegionName(activeRoute.group, activeRoute.country)} | {formatKm(activeRoute.distanceKm)} km |{" "}
                            {formatMeters(activeRoute.elevationGainM)} m stijgen
                          </Text>
                        </View>
                      ) : null}
                    </>
                  ) : null}

                  {sortedRouteGroups.map(([group, groupRoutes]) => {
                    const expanded = expandedRouteGroups[group] ?? group === activeRouteGroup;

                    return (
                      <View key={group} style={styles.routeGroup}>
                        <Pressable style={styles.groupHeader} onPress={() => toggleRouteGroup(group)}>
                          <Text style={styles.groupTitle}>{group}</Text>
                          <Text style={styles.groupMeta}>
                            {groupRoutes.length} routes {expanded ? "-" : "+"}
                          </Text>
                        </Pressable>
                        {expanded
                          ? groupRoutes.map((route) => {
                              const selected = route.id === activeRoute?.id;
                              const inOverview = isRouteInOverview(route.id);

                              return (
                                <View key={route.id} style={styles.routeRowShell}>
                                  <Pressable
                                    style={[styles.routeRow, selected && styles.routeRowSelected]}
                                    onPress={() => selectRoute(route)}
                                  >
                                    <View style={[styles.routeColor, { backgroundColor: route.color }]} />
                                    <View style={styles.routeTextBlock}>
                                      <Text style={styles.routeName} numberOfLines={1}>
                                        {route.name}
                                      </Text>
                                      <Text style={styles.routeSub}>
                                        {route.country} | {formatKm(route.distanceKm)} km
                                      </Text>
                                    </View>
                                  </Pressable>
                                  <Pressable
                                    style={[styles.iconAction, inOverview && styles.iconActionActive]}
                                    onPress={() => toggleRouteInOverview(route)}
                                  >
                                    <Text style={[styles.iconActionText, inOverview && styles.iconActionTextActive]}>
                                      {inOverview ? "Aan" : "Kaart"}
                                    </Text>
                                  </Pressable>
                                  <Pressable style={styles.iconAction} onPress={() => addRouteToPlan(route)}>
                                    <Text style={styles.iconActionText}>+</Text>
                                  </Pressable>
                                </View>
                              );
                            })
                          : null}
                      </View>
                    );
                  })}
                </>
              ) : null}

              {activePanel === "manage" ? (
                <>
                  <View style={styles.sectionHeader}>
                    <View>
                      <Text style={styles.sectionTitle}>Beheer</Text>
                      <Text style={styles.mutedText}>
                        Bepaal welke ingelogde gebruikers routes van een groepsrit kunnen zien.
                      </Text>
                    </View>
                  </View>

                  {!session?.user ? (
                    <View style={styles.lockedPanel}>
                      <Text style={styles.routeName}>Login nodig</Text>
                      <Text style={styles.routeSub}>Alleen ingelogde rijders kunnen route-toegang beheren.</Text>
                      <TextInput
                        value={email}
                        onChangeText={setEmail}
                        autoCapitalize="none"
                        keyboardType="email-address"
                        placeholder="email@example.com"
                        placeholderTextColor="#6b7280"
                        style={styles.input}
                      />
                      <TextInput
                        value={password}
                        onChangeText={setPassword}
                        secureTextEntry
                        placeholder="Wachtwoord"
                        placeholderTextColor="#6b7280"
                        style={styles.input}
                      />
                      <View style={styles.actionGrid}>
                        <Pressable
                          style={[styles.primaryButton, (!isSupabaseConfigured || !email.trim() || !password) && styles.disabledButton]}
                          disabled={!isSupabaseConfigured || !email.trim() || !password}
                          onPress={handlePasswordSignIn}
                        >
                          <Text style={styles.primaryButtonText}>Login</Text>
                        </Pressable>
                        <Pressable
                          style={[
                            styles.secondaryButton,
                            (!isSupabaseConfigured || !email.trim() || password.length < 6) && styles.disabledButton
                          ]}
                          disabled={!isSupabaseConfigured || !email.trim() || password.length < 6}
                          onPress={handlePasswordSignUp}
                        >
                          <Text style={styles.secondaryButtonText}>Nieuw</Text>
                        </Pressable>
                      </View>
                      {authMessage ? <Text style={styles.mutedText}>{authMessage}</Text> : null}
                    </View>
                  ) : (
                    <>
                      <View style={styles.manageCard}>
                        <Text style={styles.routeName}>{activeTrip ? activeTrip.name : "Geen groepsrit actief"}</Text>
                        <Text style={styles.routeSub}>
                          {activeTrip
                            ? `Code ${activeTrip.shareCode} | private routes zijn zichtbaar voor ritleden`
                            : "Maak een groepsrit of open een bestaande ritcode."}
                        </Text>
                        <TextInput
                          value={tripCodeInput}
                          onChangeText={(text) => setTripCodeInput(text.toUpperCase())}
                          placeholder="Ritcode"
                          placeholderTextColor="#6b7280"
                          autoCapitalize="characters"
                          style={styles.input}
                        />
                        <View style={styles.actionGrid}>
                          <Pressable style={styles.secondaryButton} onPress={createTrip}>
                            <Text style={styles.secondaryButtonText}>Nieuw</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.secondaryButton, !tripCodeInput.trim() && styles.disabledButton]}
                            disabled={!tripCodeInput.trim()}
                            onPress={joinTrip}
                          >
                            <Text style={styles.secondaryButtonText}>Join</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.secondaryButton, !activeTrip && styles.disabledButton]}
                            disabled={!activeTrip}
                            onPress={leaveTrip}
                          >
                            <Text style={styles.secondaryButtonText}>Uit</Text>
                          </Pressable>
                        </View>
                      </View>

                      {activeTrip ? (
                        <View style={styles.manageCard}>
                          <Text style={styles.routeName}>Leden</Text>
                          <Text style={styles.routeSub}>{tripMembers.length} rijders met toegang</Text>
                          <TextInput
                            value={memberEmail}
                            onChangeText={setMemberEmail}
                            autoCapitalize="none"
                            keyboardType="email-address"
                            placeholder="rijder@email.nl"
                            placeholderTextColor="#6b7280"
                            style={styles.input}
                          />
                          <Pressable
                            style={[styles.primaryButton, !memberEmail.trim() && styles.disabledButton]}
                            disabled={!memberEmail.trim()}
                            onPress={() => void addTripMemberByEmail()}
                          >
                            <Text style={styles.primaryButtonText}>Lid toevoegen</Text>
                          </Pressable>
                          {tripMembersLoading ? <ActivityIndicator color="#f97316" /> : null}
                          {tripMembers.map((member) => (
                            <View key={member.userId} style={styles.manageMemberRow}>
                              <View style={styles.routeTextBlock}>
                                <Text style={styles.routeName} numberOfLines={1}>
                                  {member.email}
                                </Text>
                                <Text style={styles.routeSub}>{member.role === "owner" ? "Eigenaar" : "Rijder"}</Text>
                              </View>
                              <Pressable
                                style={[styles.iconAction, member.role === "owner" && styles.disabledButton]}
                                disabled={member.role === "owner"}
                                onPress={() => void removeTripMemberByEmail(member.email)}
                              >
                                <Text style={styles.iconActionText}>Uit</Text>
                              </Pressable>
                            </View>
                          ))}
                        </View>
                      ) : null}

                      <View style={styles.manageCard}>
                        <Text style={styles.routeName}>Routezichtbaarheid</Text>
                        <Text style={styles.routeSub}>
                          Publiek is zichtbaar voor alle ingelogde rijders. Prive is alleen zichtbaar voor eigenaar en gekoppelde ritleden.
                        </Text>
                        {routes.length === 0 ? (
                          <Text style={styles.mutedText}>Nog geen routes geladen.</Text>
                        ) : (
                          routes.map((route) => {
                            const isPublic = route.isPublic ?? false;

                            return (
                              <View key={route.id} style={styles.manageRouteRow}>
                                <View style={[styles.routeColor, { backgroundColor: route.color }]} />
                                <View style={styles.routeTextBlock}>
                                  <Text style={styles.routeName} numberOfLines={1}>
                                    {route.name}
                                  </Text>
                                  <Text style={styles.routeSub}>
                                    {route.country} | {routeTypeLabel(route.routeType)} | {isPublic ? "Publiek" : "Prive"}
                                  </Text>
                                </View>
                                <Pressable
                                  style={[
                                    styles.iconAction,
                                    isPublic && styles.iconActionActive,
                                    routeVisibilitySaving === route.id && styles.disabledButton
                                  ]}
                                  disabled={routeVisibilitySaving === route.id}
                                  onPress={() => void toggleRouteVisibility(route)}
                                >
                                  <Text style={[styles.iconActionText, isPublic && styles.iconActionTextActive]}>
                                    {isPublic ? "Open" : "Prive"}
                                  </Text>
                                </Pressable>
                              </View>
                            );
                          })
                        )}
                      </View>
                      {manageMessage || tripMessage ? (
                        <Text style={styles.mutedText}>{manageMessage ?? tripMessage}</Text>
                      ) : null}
                    </>
                  )}
                </>
              ) : null}

              {activePanel === "plan" ? (
                <>
                  <View style={styles.sectionHeader}>
                    <View>
                      <Text style={styles.sectionTitle}>Dagschema</Text>
                      <Text style={styles.mutedText}>
                        {dayPlanItems.length} etappes | {formatKm(planStats.distanceKm)} km |{" "}
                        {formatDuration(planStats.totalMinutes)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.planSummaryGrid}>
                    <View style={styles.statTile}>
                      <Text style={styles.statLabel}>Afstand</Text>
                      <Text style={styles.statValue}>{formatKm(planStats.distanceKm)} km</Text>
                    </View>
                    <View style={styles.statTile}>
                      <Text style={styles.statLabel}>Stijgen</Text>
                      <Text style={styles.statValue}>{formatMeters(planStats.elevationGainM)} m</Text>
                    </View>
                    <View style={styles.statTile}>
                      <Text style={styles.statLabel}>Tijd</Text>
                      <Text style={styles.statValue}>{formatDuration(planStats.totalMinutes)}</Text>
                    </View>
                  </View>

                  {activeRoute ? (
                    <Pressable style={styles.primaryButton} onPress={() => addRouteToPlan(activeRoute)}>
                      <Text style={styles.primaryButtonText}>Actieve route toevoegen</Text>
                    </Pressable>
                  ) : null}

                  <View style={styles.mapPointPanel}>
                    <View style={styles.sectionHeader}>
                      <View>
                        <Text style={styles.sectionTitle}>Kaartpunten</Text>
                        <Text style={styles.mutedText}>{mapPoints.length} punten</Text>
                      </View>
                    </View>
                    <View style={styles.pointTypeGrid}>
                      {MAP_POINT_TYPES.map((type) => {
                        const selected = pointType === type;
                        return (
                          <Pressable
                            key={type}
                            style={[styles.pointTypeButton, selected && styles.pointTypeButtonActive]}
                            onPress={() => {
                              setPointType(type);
                              if (!pointName.trim() || pointName === mapPointLabel(pointType)) {
                                setPointName(mapPointLabel(type));
                              }
                            }}
                          >
                            <Text style={[styles.pointTypeText, selected && styles.pointTypeTextActive]}>
                              {mapPointLabel(type)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <TextInput
                      value={pointName}
                      onChangeText={setPointName}
                      placeholder="Naam punt"
                      placeholderTextColor="#6b7280"
                      style={styles.input}
                    />
                    <View style={styles.coordinateRow}>
                      <TextInput
                        value={pointCoordinates}
                        onChangeText={(text) => {
                          setPointCoordinates(text);
                          setPointError(null);
                        }}
                        placeholder="52.196562, -3.749340"
                        placeholderTextColor="#6b7280"
                        style={[styles.input, styles.coordinateInput]}
                      />
                      <Pressable style={styles.iconAction} onPress={addPointFromCoordinates}>
                        <Text style={styles.iconActionText}>+</Text>
                      </Pressable>
                    </View>
                    <TextInput
                      value={pointNote}
                      onChangeText={setPointNote}
                      placeholder="Notitie"
                      placeholderTextColor="#6b7280"
                      style={styles.input}
                    />
                    <View style={styles.actionGrid}>
                      <Pressable
                        style={[styles.secondaryButton, mapPickMode && styles.compactButtonActive]}
                        onPress={toggleMapPickMode}
                      >
                        <Text style={styles.secondaryButtonText}>{mapPickMode ? "Kaart actief" : "Plaats via kaart"}</Text>
                      </Pressable>
                      <Pressable style={[styles.secondaryButton, !ownLocation && styles.disabledButton]} onPress={addPointAtOwnLocation}>
                        <Text style={styles.secondaryButtonText}>Mijn GPS</Text>
                      </Pressable>
                      <Pressable style={[styles.secondaryButton, !activeRoute && styles.disabledButton]} onPress={addPointAtRouteEnd}>
                        <Text style={styles.secondaryButtonText}>Route-einde</Text>
                      </Pressable>
                    </View>
                    <View style={styles.actionGrid}>
                      <Pressable style={[styles.secondaryButton, !ownLocation && styles.disabledButton]} onPress={fillCoordinatesFromOwnLocation}>
                        <Text style={styles.secondaryButtonText}>Vul GPS</Text>
                      </Pressable>
                      <Pressable style={[styles.secondaryButton, !activeRoute && styles.disabledButton]} onPress={fillCoordinatesFromRouteEnd}>
                        <Text style={styles.secondaryButtonText}>Vul einde</Text>
                      </Pressable>
                    </View>
                    {pointError ? <Text style={styles.errorText}>{pointError}</Text> : null}
                    {mapPoints.map((point, index) => (
                      <View key={point.id} style={styles.pointRow}>
                        <View style={[styles.pointNumber, { backgroundColor: mapPointColor(point.type) }]}>
                          <Text style={styles.pointNumberText}>{mapPointSymbol(point.type)}</Text>
                        </View>
                        <View style={styles.routeTextBlock}>
                          <Text style={styles.routeName}>
                            {index + 1}. {point.name}
                          </Text>
                          <Text style={styles.routeSub}>{point.note ?? formatCoordinate(point.lat, point.lng)}</Text>
                        </View>
                        <Pressable style={styles.iconAction} onPress={() => removeMapPoint(point.id)}>
                          <Text style={styles.iconActionText}>x</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>

                  {dayPlanItems.length === 0 ? (
                    <Text style={styles.emptyText}>Voeg routes toe met de plusknop in Routes of vanuit het overzicht.</Text>
                  ) : (
                    <View style={styles.routeGroup}>
                      {dayPlanItems.map((item, index) => {
                        const route = routeMap.get(item.routeId);
                        if (!route) return null;

                        return (
                          <View key={item.id} style={[styles.planItem, route.id === activeRoute?.id && styles.routeRowSelected]}>
                            <Pressable style={styles.planItemMain} onPress={() => selectRoute(route)}>
                              <View style={styles.pointNumber}>
                                <Text style={styles.pointNumberText}>{index + 1}</Text>
                              </View>
                              <View style={styles.routeTextBlock}>
                                <Text style={styles.routeName} numberOfLines={1}>
                                  {route.name}
                                </Text>
                                <Text style={styles.routeSub}>
                                  {formatKm(route.distanceKm)} km | {formatDuration(estimateRouteMinutes(route))}
                                </Text>
                              </View>
                            </Pressable>
                            <View style={styles.planControls}>
                              <Pressable style={styles.iconAction} disabled={index === 0} onPress={() => movePlanItem(item.id, -1)}>
                                <Text style={styles.iconActionText}>Up</Text>
                              </Pressable>
                              <Pressable
                                style={styles.iconAction}
                                disabled={index === dayPlanItems.length - 1}
                                onPress={() => movePlanItem(item.id, 1)}
                              >
                                <Text style={styles.iconActionText}>Down</Text>
                              </Pressable>
                              <Pressable style={styles.iconAction} onPress={() => removePlanItem(item.id)}>
                                <Text style={styles.iconActionText}>x</Text>
                              </Pressable>
                            </View>
                            <View style={styles.planFields}>
                              <TextInput
                                value={item.startTime}
                                onChangeText={(text) => updatePlanItem(item.id, { startTime: text })}
                                placeholder="09:00"
                                style={[styles.input, styles.planFieldInput]}
                              />
                              <TextInput
                                value={String(item.breakMinutes)}
                                onChangeText={(text) =>
                                  updatePlanItem(item.id, {
                                    breakMinutes: Math.max(0, Number.parseInt(text || "0", 10))
                                  })
                                }
                                keyboardType="numeric"
                                placeholder="Pauze"
                                style={[styles.input, styles.planFieldInput]}
                              />
                            </View>
                            <TextInput
                              value={item.note}
                              onChangeText={(text) => updatePlanItem(item.id, { note: text })}
                              placeholder="Notitie"
                              placeholderTextColor="#6b7280"
                              style={styles.input}
                            />
                          </View>
                        );
                      })}
                    </View>
                  )}
                </>
              ) : null}

          {activePanel === "planner" ? (
            <>
              <View style={styles.sectionHeader}>
                <View>
                  <Text style={styles.sectionTitle}>Waypoint navigatie</Text>
                  <Text style={styles.mutedText}>
                    {plannerPoints.length} punten | {formatKm(plannerDistanceKm)} km direct
                  </Text>
                </View>
                <Pressable
                  style={[styles.compactButton, plannerEnabled && styles.compactButtonActive]}
                  onPress={() => setPlannerEnabled((current) => !current)}
                >
                  <Text style={[styles.compactButtonText, plannerEnabled && styles.compactButtonTextActive]}>
                    {plannerEnabled ? "Aan" : "Uit"}
                  </Text>
                </Pressable>
              </View>

              <View style={styles.modeSwitch}>
                {(["roadtrip", "4x4"] as RouteType[]).map((type) => {
                  const selected = plannerRouteType === type;
                  return (
                    <Pressable
                      key={type}
                      style={[styles.modeOption, selected && styles.modeOptionActive]}
                      disabled={plannerSaving}
                      onPress={() => setPlannerRouteType(type)}
                    >
                      <Text style={[styles.modeOptionText, selected && styles.modeOptionTextActive]}>
                        {routeTypeLabel(type)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.actionGrid}>
                <Pressable style={styles.secondaryButton} onPress={addOwnLocationAsPoint}>
                  <Text style={styles.secondaryButtonText}>GPS punt</Text>
                </Pressable>
                <Pressable
                  style={[styles.secondaryButton, plannerPoints.length === 0 && styles.disabledButton]}
                  disabled={plannerPoints.length === 0}
                  onPress={removeLastPlannerPoint}
                >
                  <Text style={styles.secondaryButtonText}>Undo</Text>
                </Pressable>
                <Pressable
                  style={[styles.secondaryButton, plannerPoints.length === 0 && styles.disabledButton]}
                  disabled={plannerPoints.length === 0}
                  onPress={clearPlannerPoints}
                >
                  <Text style={styles.secondaryButtonText}>Wis</Text>
                </Pressable>
                <Pressable
                  style={[styles.primaryButton, (plannerPoints.length < 2 || plannerSaving) && styles.disabledButton]}
                  disabled={plannerPoints.length < 2 || plannerSaving}
                  onPress={createWaypointRoute}
                >
                  <Text style={styles.primaryButtonText}>
                    {plannerSaving
                      ? "Maken..."
                      : plannerRouteType === "roadtrip"
                        ? "Maak wegenroute"
                        : "Maak offroad route"}
                  </Text>
                </Pressable>
              </View>

              {plannerRouteMessage ? <Text style={styles.plannerMessage}>{plannerRouteMessage}</Text> : null}

              {plannerPoints.length > 0 ? (
                <View style={styles.routeGroup}>
                  <Text style={styles.groupTitle}>Nieuwe punten</Text>
                  {plannerPoints.map((point, index) => (
                    <View key={point.id} style={styles.pointRow}>
                      <View style={styles.pointNumber}>
                        <Text style={styles.pointNumberText}>{index + 1}</Text>
                      </View>
                      <View style={styles.routeTextBlock}>
                        <Text style={styles.routeName}>{point.name}</Text>
                        <Text style={styles.routeSub}>
                          {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.emptyText}>Zet Waypoints op Aan en tik op de kaart.</Text>
              )}

              {activeRoute && targetWaypoint ? (
                <View style={styles.navigationCard}>
                  <Text style={styles.routeType}>Actieve navigatie</Text>
                  <Text style={styles.activeRouteName}>{activeRoute.name}</Text>
                  <Text style={styles.routeMeta}>
                    Punt {safeTargetWaypointIndex + 1} van {navigationWaypoints.length}: {targetWaypoint.name}
                  </Text>
                  <Text style={styles.navigationMetric}>
                    {targetDistanceM === null ? "Geen GPS afstand" : formatNavigationDistance(targetDistanceM)}
                    {targetBearing === null ? "" : ` | ${targetBearing} graden`}
                  </Text>
                  <View style={styles.navigationActions}>
                    <Pressable
                      style={[styles.secondaryButton, safeTargetWaypointIndex === 0 && styles.disabledButton]}
                      disabled={safeTargetWaypointIndex === 0}
                      onPress={goToPreviousWaypoint}
                    >
                      <Text style={styles.secondaryButtonText}>Vorige</Text>
                    </Pressable>
                    <Pressable
                      style={[
                        styles.primaryButton,
                        safeTargetWaypointIndex >= navigationWaypoints.length - 1 && styles.disabledButton
                      ]}
                      disabled={safeTargetWaypointIndex >= navigationWaypoints.length - 1}
                      onPress={goToNextWaypoint}
                    >
                      <Text style={styles.primaryButtonText}>Volgende</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </>
          ) : null}

          {activePanel === "record" ? (
            <>
              <View style={styles.sectionHeader}>
                <View>
                  <Text style={styles.sectionTitle}>Route opnemen</Text>
                  <Text style={styles.mutedText}>
                    {recordedPoints.length} punten | {formatKm(recordedDistanceKm)} km
                  </Text>
                </View>
                <View style={[styles.recordDot, recordingActive && styles.recordDotActive]} />
              </View>

              <View style={styles.modeSwitch}>
                {(["4x4", "roadtrip"] as RouteType[]).map((type) => {
                  const selected = recordingRouteType === type;
                  return (
                    <Pressable
                      key={type}
                      style={[styles.modeOption, selected && styles.modeOptionActive]}
                      disabled={recordingActive || recordingSaving}
                      onPress={() => setRecordingRouteType(type)}
                    >
                      <Text style={[styles.modeOptionText, selected && styles.modeOptionTextActive]}>
                        {routeTypeLabel(type)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.recordingCard}>
                <Text style={styles.routeType}>{recordingActive ? "Opname actief" : "Opname klaar"}</Text>
                <Text style={styles.activeRouteName}>
                  {recordingActive ? "GPS-track wordt vastgelegd" : "Start een nieuwe track"}
                </Text>
                <Text style={styles.routeMeta}>
                  Alleen GPS-punten met goede nauwkeurigheid worden opgeslagen.
                </Text>
                <Text style={styles.navigationMetric}>{formatKm(recordedDistanceKm)} km</Text>
              </View>

              <View style={styles.actionGrid}>
                <Pressable
                  style={recordingActive ? styles.secondaryButton : styles.primaryButton}
                  disabled={recordingSaving}
                  onPress={recordingActive ? pauseRecording : startRecording}
                >
                  <Text style={recordingActive ? styles.secondaryButtonText : styles.primaryButtonText}>
                    {recordingActive ? "Pauzeer" : recordedPoints.length > 0 ? "Hervat" : "Start"}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.secondaryButton, (recordedPoints.length === 0 || recordingSaving) && styles.disabledButton]}
                  disabled={recordedPoints.length === 0 || recordingSaving}
                  onPress={resetRecording}
                >
                  <Text style={styles.secondaryButtonText}>Wis</Text>
                </Pressable>
                <Pressable
                  style={[styles.primaryButton, (recordedPoints.length < 2 || recordingSaving) && styles.disabledButton]}
                  disabled={recordedPoints.length < 2 || recordingSaving}
                  onPress={saveRecordingRoute}
                >
                  <Text style={styles.primaryButtonText}>{recordingSaving ? "Opslaan..." : "Sla route op"}</Text>
                </Pressable>
              </View>

              {recordingMessage ? <Text style={styles.plannerMessage}>{recordingMessage}</Text> : null}
            </>
          ) : null}

            </ScrollView>
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0f172a"
  },
  map: {
    flex: 1
  },
  topBar: {
    position: "absolute",
    top: 46,
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8
  },
  topInfo: {
    flex: 1,
    minHeight: 42,
    justifyContent: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(248, 250, 252, 0.16)",
    backgroundColor: "rgba(15, 23, 42, 0.58)",
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  appName: {
    color: "#f8fafc",
    fontSize: 14,
    fontWeight: "800"
  },
  statusText: {
    color: "#cbd5e1",
    fontSize: 10,
    marginTop: 2
  },
  topActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6
  },
  rideButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(248, 250, 252, 0.18)",
    backgroundColor: "rgba(15, 23, 42, 0.48)"
  },
  rideButtonActive: {
    borderColor: "#f97316",
    backgroundColor: "#f97316"
  },
  rideButtonText: {
    color: "#f8fafc",
    fontSize: 10,
    fontWeight: "800"
  },
  rideButtonTextActive: {
    color: "#111827"
  },
  liveButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(248, 250, 252, 0.18)",
    backgroundColor: "rgba(15, 23, 42, 0.48)"
  },
  liveButtonActive: {
    borderColor: "#14b8a6",
    backgroundColor: "#14b8a6"
  },
  liveButtonText: {
    color: "#f8fafc",
    fontSize: 10,
    fontWeight: "800"
  },
  liveButtonTextActive: {
    color: "#042f2e"
  },
  planButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(248, 250, 252, 0.18)",
    backgroundColor: "rgba(15, 23, 42, 0.48)"
  },
  planButtonActive: {
    borderColor: "#14b8a6",
    backgroundColor: "#14b8a6"
  },
  planButtonText: {
    color: "#f8fafc",
    fontSize: 10,
    fontWeight: "800"
  },
  planButtonTextActive: {
    color: "#042f2e"
  },
  recordButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(248, 250, 252, 0.18)",
    backgroundColor: "rgba(15, 23, 42, 0.48)"
  },
  recordButtonActive: {
    borderColor: "#ef4444",
    backgroundColor: "#ef4444"
  },
  recordButtonText: {
    color: "#f8fafc",
    fontSize: 10,
    fontWeight: "800"
  },
  recordButtonTextActive: {
    color: "#fff"
  },
  locationButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(248, 250, 252, 0.18)",
    backgroundColor: "rgba(249, 115, 22, 0.82)"
  },
  locationButtonActive: {
    borderColor: "#38bdf8",
    backgroundColor: "#38bdf8"
  },
  locationButtonText: {
    color: "#111827",
    fontSize: 10,
    fontWeight: "800"
  },
  locationButtonTextActive: {
    color: "#082f49"
  },
  gpsBadge: {
    position: "absolute",
    top: 102,
    left: 16,
    right: 110,
    borderRadius: 14,
    backgroundColor: "rgba(255, 255, 255, 0.95)",
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  gpsBadgeText: {
    fontWeight: "800"
  },
  gpsBadgeSub: {
    color: "#475569",
    fontSize: 12,
    marginTop: 2
  },
  mapModeBadge: {
    position: "absolute",
    top: 102,
    left: 16,
    right: 16,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderRadius: 14,
    backgroundColor: "rgba(17, 24, 39, 0.92)",
    paddingHorizontal: 14,
    paddingVertical: 8
  },
  mapModeText: {
    flex: 1,
    color: "#f8fafc",
    fontWeight: "800"
  },
  mapModeCancel: {
    minHeight: 32,
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: "#f8fafc",
    paddingHorizontal: 12
  },
  mapModeCancelText: {
    color: "#111827",
    fontWeight: "800"
  },
  rideOverlay: {
    position: "absolute",
    top: 152,
    left: 16,
    minWidth: 150,
    gap: 2,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(15, 23, 42, 0.14)",
    backgroundColor: "rgba(255, 255, 255, 0.96)",
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  rideOverlayWarning: {
    borderColor: "rgba(220, 38, 38, 0.38)",
    backgroundColor: "rgba(254, 242, 242, 0.98)"
  },
  rideOverlayTitle: {
    color: "#0f172a",
    fontWeight: "800"
  },
  rideOverlayTitleWarning: {
    color: "#b91c1c"
  },
  rideOverlayText: {
    color: "#475569",
    fontSize: 12,
    marginTop: 2
  },
  zoomControls: {
    position: "absolute",
    right: 16,
    top: 102,
    gap: 8
  },
  zoomButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: "rgba(255, 255, 255, 0.96)"
  },
  zoomButtonText: {
    color: "#111827",
    fontSize: 24,
    fontWeight: "800"
  },
  liveOverlay: {
    position: "absolute",
    top: 102,
    left: 16,
    right: 16,
    gap: 10,
    borderRadius: 16,
    backgroundColor: "rgba(248, 250, 252, 0.98)",
    padding: 14
  },
  liveOverlayHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  liveOverlayTitle: {
    color: "#0f172a",
    fontSize: 17,
    fontWeight: "800"
  },
  closeButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 17,
    backgroundColor: "#e2e8f0"
  },
  closeButtonText: {
    color: "#111827",
    fontWeight: "800"
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: "#f8fafc",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 28
  },
  sheetCompact: {
    height: 96
  },
  sheetHalf: {
    height: "46%"
  },
  sheetExpanded: {
    height: "84%"
  },
  sheetHeader: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10
  },
  sheetHandle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 52
  },
  sheetGrip: {
    width: 36,
    height: 5,
    borderRadius: 999,
    backgroundColor: "#94a3b8"
  },
  sheetSummary: {
    flex: 1
  },
  sheetSummaryTitle: {
    color: "#0f172a",
    fontWeight: "800"
  },
  sheetSummaryDetail: {
    color: "#64748b",
    fontSize: 12,
    marginTop: 2
  },
  sheetActions: {
    flexDirection: "row",
    gap: 8
  },
  sheetActionButton: {
    minHeight: 36,
    justifyContent: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    paddingHorizontal: 12
  },
  sheetActionText: {
    color: "#0f172a",
    fontWeight: "800"
  },
  sheetScroll: {
    flex: 1
  },
  sheetContent: {
    paddingBottom: 22
  },
  panelTabs: {
    flexDirection: "row",
    gap: 4,
    marginBottom: 12
  },
  panelTab: {
    flex: 1,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff"
  },
  panelTabActive: {
    borderColor: "#111827",
    backgroundColor: "#111827"
  },
  panelTabText: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "800"
  },
  panelTabTextActive: {
    color: "#f8fafc"
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  sectionTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "800"
  },
  recordDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#94a3b8"
  },
  recordDotActive: {
    backgroundColor: "#ef4444"
  },
  errorText: {
    marginTop: 8,
    color: "#b91c1c"
  },
  searchInput: {
    minHeight: 44,
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff",
    color: "#0f172a",
    paddingHorizontal: 12
  },
  filterGrid: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12
  },
  filterCard: {
    flex: 1,
    minHeight: 58,
    justifyContent: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff",
    paddingHorizontal: 12
  },
  filterCardActive: {
    borderColor: "#0f766e",
    backgroundColor: "#ccfbf1"
  },
  filterCardTitle: {
    color: "#0f172a",
    fontWeight: "800"
  },
  filterCardTitleActive: {
    color: "#0f766e"
  },
  filterCardMeta: {
    color: "#64748b",
    fontSize: 12,
    marginTop: 2
  },
  filterCardMetaActive: {
    color: "#0f766e"
  },
  segmentedRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10
  },
  segmentButton: {
    flex: 1,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff",
    paddingHorizontal: 8
  },
  segmentButtonActive: {
    borderColor: "#111827",
    backgroundColor: "#111827"
  },
  segmentButtonText: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "800"
  },
  segmentButtonTextActive: {
    color: "#f8fafc"
  },
  overviewCard: {
    gap: 8,
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    padding: 12
  },
  overviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  overviewTitle: {
    color: "#0f172a",
    fontWeight: "800"
  },
  connectionList: {
    gap: 4,
    marginTop: 4
  },
  activeRouteSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#f97316",
    backgroundColor: "#fff7ed",
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  lockedPanel: {
    gap: 10,
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    padding: 12
  },
  activeCard: {
    marginTop: 12,
    borderRadius: 14,
    backgroundColor: "#111827",
    padding: 14
  },
  routeType: {
    color: "#f97316",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  activeRouteName: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "800",
    marginTop: 4
  },
  routeMeta: {
    color: "#cbd5e1",
    marginTop: 6
  },
  routeGroup: {
    marginTop: 16
  },
  actionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12
  },
  modeSwitch: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12
  },
  modeOption: {
    flex: 1,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff"
  },
  modeOptionActive: {
    borderColor: "#0f766e",
    backgroundColor: "#ccfbf1"
  },
  modeOptionText: {
    color: "#334155",
    fontWeight: "800"
  },
  modeOptionTextActive: {
    color: "#0f766e"
  },
  groupTitle: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  groupHeader: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 12,
    backgroundColor: "#e2e8f0",
    paddingHorizontal: 12,
    marginBottom: 8
  },
  groupMeta: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "800"
  },
  routeRowShell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8
  },
  routeRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  routeRowSelected: {
    borderColor: "#f97316",
    backgroundColor: "#fff7ed"
  },
  routeColor: {
    width: 12,
    height: 36,
    borderRadius: 999
  },
  routeTextBlock: {
    flex: 1
  },
  routeName: {
    color: "#0f172a",
    fontWeight: "800"
  },
  routeSub: {
    color: "#64748b",
    marginTop: 2
  },
  routeActionText: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "800"
  },
  iconAction: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff",
    paddingHorizontal: 10
  },
  iconActionActive: {
    borderColor: "#0f766e",
    backgroundColor: "#ccfbf1"
  },
  iconActionText: {
    color: "#0f172a",
    fontWeight: "800"
  },
  iconActionTextActive: {
    color: "#0f766e"
  },
  compactButton: {
    minWidth: 56,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff"
  },
  compactButtonActive: {
    borderColor: "#0f766e",
    backgroundColor: "#ccfbf1"
  },
  compactButtonText: {
    color: "#334155",
    fontWeight: "800"
  },
  compactButtonTextActive: {
    color: "#0f766e"
  },
  pointRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8
  },
  pointNumber: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
    backgroundColor: "#0f766e"
  },
  pointNumberText: {
    color: "#fff",
    fontWeight: "800"
  },
  planSummaryGrid: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
    marginBottom: 12
  },
  statTile: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    padding: 10
  },
  statLabel: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  statValue: {
    color: "#0f172a",
    fontWeight: "800",
    marginTop: 4
  },
  mapPointPanel: {
    gap: 10,
    marginTop: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    padding: 12
  },
  tripBox: {
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    padding: 12
  },
  manageCard: {
    gap: 10,
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    padding: 12
  },
  manageMemberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 8
  },
  manageRouteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 8
  },
  pointTypeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  pointTypeButton: {
    minHeight: 38,
    width: "31%",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff",
    paddingHorizontal: 6
  },
  pointTypeButtonActive: {
    borderColor: "#7c3aed",
    backgroundColor: "#ede9fe"
  },
  pointTypeText: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "800"
  },
  pointTypeTextActive: {
    color: "#5b21b6"
  },
  coordinateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  coordinateInput: {
    flex: 1
  },
  planItem: {
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    padding: 12,
    marginBottom: 10
  },
  planItemMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10
  },
  planControls: {
    flexDirection: "row",
    gap: 8
  },
  planFields: {
    flexDirection: "row",
    gap: 8
  },
  planFieldInput: {
    flex: 1
  },
  emptyText: {
    marginTop: 14,
    color: "#64748b",
    lineHeight: 20
  },
  plannerMessage: {
    marginTop: 10,
    color: "#0f766e",
    fontWeight: "700"
  },
  navigationCard: {
    marginTop: 16,
    borderRadius: 14,
    backgroundColor: "#111827",
    padding: 14
  },
  recordingCard: {
    marginTop: 12,
    borderRadius: 14,
    backgroundColor: "#111827",
    padding: 14
  },
  navigationMetric: {
    color: "#f8fafc",
    fontSize: 20,
    fontWeight: "800",
    marginTop: 10
  },
  navigationActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12
  },
  loginPanel: {
    gap: 10,
    paddingTop: 2,
    paddingBottom: 8
  },
  mutedText: {
    color: "#64748b",
    lineHeight: 20
  },
  input: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff",
    color: "#0f172a",
    paddingHorizontal: 12
  },
  primaryButton: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: "#f97316",
    paddingHorizontal: 14
  },
  primaryButtonText: {
    color: "#111827",
    fontWeight: "800"
  },
  secondaryButton: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    paddingHorizontal: 14
  },
  secondaryButtonText: {
    color: "#0f172a",
    fontWeight: "800"
  },
  disabledButton: {
    opacity: 0.45
  },
  riderList: {
    gap: 10
  },
  ownMarker: {
    width: 54,
    height: 54,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 27,
    borderWidth: 3
  },
  ownMarkerCore: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 3,
    borderColor: "#fff"
  },
  riderMarker: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 17,
    borderWidth: 2,
    borderColor: "#fff"
  },
  riderMarkerText: {
    color: "#fff",
    fontWeight: "800"
  },
  waypointMarker: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
    borderWidth: 2,
    borderColor: "#111827",
    backgroundColor: "#f8fafc"
  },
  targetWaypointMarker: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderColor: "#f97316",
    backgroundColor: "#111827"
  },
  waypointMarkerText: {
    color: "#111827",
    fontWeight: "800"
  },
  targetWaypointText: {
    color: "#f97316"
  },
  plannerMarker: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 17,
    borderWidth: 2,
    borderColor: "#fff",
    backgroundColor: "#0f766e"
  },
  plannerMarkerText: {
    color: "#fff",
    fontWeight: "800"
  },
  mapPointMarker: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    borderWidth: 2,
    borderColor: "#fff"
  },
  mapPointMarkerText: {
    color: "#fff",
    fontWeight: "800"
  },
  mapPointIndex: {
    position: "absolute",
    right: -5,
    bottom: -5,
    minWidth: 18,
    height: 18,
    overflow: "hidden",
    textAlign: "center",
    borderRadius: 9,
    backgroundColor: "#111827",
    color: "#fff",
    fontSize: 10,
    fontWeight: "800"
  }
});
