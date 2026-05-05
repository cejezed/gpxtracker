"use client";

import {
  Activity,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Car,
  Camera,
  Crosshair,
  Eye,
  EyeOff,
  Flag,
  FileUp,
  Fuel,
  Gauge,
  Layers3,
  LocateFixed,
  LogIn,
  LogOut,
  ListChecks,
  ListPlus,
  MapPinned,
  MapPin,
  Maximize2,
  Minimize2,
  Mountain,
  Plus,
  Radio,
  Route as RouteIcon,
  Search,
  Tent,
  Trash2,
  Utensils,
  Users,
  Wrench
} from "lucide-react";
import { ChangeEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { formatKm, formatMeters, parseGpxRoute } from "@/lib/gpx";
import { sampleRoutes, type SampleRoute } from "@/lib/sample-routes";
import { buildRoadRoute } from "@/lib/routing";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { loadPublicSupabaseRoutes } from "@/lib/supabase-routes";
import { useLiveLocation } from "@/lib/live-location";
import type { GpxRoute, MapPoint, MapPointType, RiderLocation, RouteCountry, RoutePoint, RouteType } from "@/lib/types";
import { RouteMap } from "@/components/route-map";

const TRIP_ID = "default-trip";
const COUNTRIES: Array<"all" | RouteCountry> = ["all", "Engeland", "Duitsland"];

type ActivePanel = "routes" | "plan" | "builder" | "record";
type MobileSheetMode = "compact" | "half" | "expanded";

type ActiveTrip = {
  id: string;
  name: string;
  shareCode: string;
};

type DayPlanItem = {
  id: string;
  routeId: string;
  startTime: string;
  breakMinutes: number;
  note: string;
};

type BuilderPoint = RoutePoint & {
  id: string;
  name: string;
};

const REGION_ORDER = ["Lake District", "Wales", "Hoch Sauerland", "Overig"];

type RouteGroupInfo = {
  country: RouteCountry;
  routeType: RouteType;
  group?: string;
};

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

function groupSamples(routes: SampleRoute[]) {
  return routes.reduce<Record<string, SampleRoute[]>>((groups, route) => {
    const key = routeGroupLabel(route);
    groups[key] = [...(groups[key] ?? []), route];
    return groups;
  }, {});
}

function groupRoutes(routes: GpxRoute[]) {
  return routes.reduce<Record<string, GpxRoute[]>>((groups, route) => {
    const key = routeGroupLabel(route);
    groups[key] = [...(groups[key] ?? []), route];
    return groups;
  }, {});
}

function routeMatchesFilters(
  route: {
    country: RouteCountry;
    routeType: RouteType;
    group?: string;
    name?: string;
    title?: string;
    fileName?: string;
  },
  query: string,
  countryFilter: "all" | RouteCountry,
  routeTypeFilter: "all" | RouteType
) {
  const haystack = `${route.country} ${route.group ?? ""} ${route.name ?? ""} ${route.title ?? ""} ${
    route.fileName ?? ""
  } ${route.routeType}`.toLowerCase();
  const matchesQuery = haystack.includes(query.toLowerCase());
  const matchesCountry = countryFilter === "all" || route.country === countryFilter;
  const matchesType = routeTypeFilter === "all" || route.routeType === routeTypeFilter;

  return matchesQuery && matchesCountry && matchesType;
}

function routeTypeLabel(routeType: RouteType) {
  return routeType === "roadtrip" ? "Roadtrip" : "Offroad";
}

function routeTypeIcon(routeType: RouteType) {
  return routeType === "roadtrip" ? Car : Mountain;
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

function mapPointIcon(type: MapPointType) {
  const icons: Record<MapPointType, typeof Tent> = {
    overnight: Tent,
    fuel: Fuel,
    food: Utensils,
    viewpoint: Camera,
    repair: Wrench,
    note: MapPin
  };

  return icons[type];
}

function parseCoordinateInput(input: string) {
  const matches = Array.from(
    input.matchAll(/([NSEW])?\s*([+-]?\d+(?:[.,]\d+)?)\s*([NSEW])?/gi)
  );

  if (matches.length < 2) {
    return null;
  }

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

function distanceKmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
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

function connectionDistanceKm(previous: GpxRoute, next: GpxRoute) {
  const previousEnd = previous.points.at(-1);
  const nextStart = next.points[0];

  if (!previousEnd || !nextStart) return 0;
  return distanceKmBetween(previousEnd, nextStart);
}

function distanceMetersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  return distanceKmBetween(a, b) * 1000;
}

function nearestRouteDistanceMeters(location: { lat: number; lng: number }, route: GpxRoute | null) {
  if (!route || route.points.length === 0) return null;

  return route.points.reduce((nearest, point) => Math.min(nearest, distanceMetersBetween(location, point)), Infinity);
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
  const trackPoints = route.points
    .map(
      (point) =>
        `      <trkpt lat="${point.lat}" lon="${point.lng}">${
          point.ele === undefined ? "" : `<ele>${point.ele}</ele>`
        }${point.time ? `<time>${escapeXml(point.time)}</time>` : ""}</trkpt>`
    )
    .join("\n");
  const waypoints = route.waypoints
    .map(
      (point) =>
        `  <wpt lat="${point.lat}" lon="${point.lng}"><name>${escapeXml(point.name)}</name></wpt>`
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
</gpx>
`;
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

function routeDistanceKm(points: RoutePoint[]) {
  let distanceKm = 0;

  for (let index = 1; index < points.length; index += 1) {
    distanceKm += distanceKmBetween(points[index - 1], points[index]);
  }

  return distanceKm;
}

function routeGeoJson(route: GpxRoute): GeoJSON.Feature {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: route.points.map((point) =>
        point.ele === undefined ? [point.lng, point.lat] : [point.lng, point.lat, point.ele]
      )
    },
    properties: {
      points: route.points,
      waypoints: route.waypoints,
      pointCount: route.points.length,
      elevationGainM: Math.round(route.elevationGainM),
      elevationLossM: Math.round(route.elevationLossM),
      sourceFile: route.fileName ?? "rallytrail-route"
    }
  };
}

function buildWaypointRoute(
  points: BuilderPoint[],
  routeType: RouteType,
  routedPoints: RoutePoint[],
  distanceKm = routeDistanceKm(routedPoints)
): GpxRoute {
  const createdAt = new Date();
  const routeLabel = routeType === "roadtrip" ? "Roadtrip route" : "Offroad waypoint route";

  return {
    id: `waypoint-${Date.now()}`,
    name: `${routeLabel} ${createdAt.toLocaleDateString("nl-NL")}`,
    source: "upload",
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
  const started = startedAt ? new Date(startedAt) : new Date();
  const dateLabel = `${started.toLocaleDateString("nl-NL")} ${started.toLocaleTimeString("nl-NL", {
    hour: "2-digit",
    minute: "2-digit"
  })}`;
  const first = points[0];
  const last = points.at(-1);

  return {
    id: `recording-${Date.now()}`,
    name: `Opgenomen ${routeTypeLabel(routeType)} ${dateLabel}`,
    source: "upload",
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

function formatRiderMeta(rider: RiderLocation) {
  const parts: string[] = [];

  if (rider.speedKmh) {
    parts.push(`${Math.round(rider.speedKmh)} km/u`);
  }

  if (rider.accuracyM) {
    parts.push(`+/-${Math.round(rider.accuracyM)} m`);
  }

  return parts.join(" - ") || "online";
}

export function TrackerApp() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sheetDragStartYRef = useRef<number | null>(null);
  const recordingWatchIdRef = useRef<number | null>(null);
  const [routes, setRoutes] = useState<GpxRoute[]>([]);
  const [dayPlanItems, setDayPlanItems] = useState<DayPlanItem[]>([]);
  const [mapPoints, setMapPoints] = useState<MapPoint[]>([]);
  const [pointType, setPointType] = useState<MapPointType>("overnight");
  const [pointName, setPointName] = useState("Overnachting");
  const [pointCoordinates, setPointCoordinates] = useState("");
  const [pointNote, setPointNote] = useState("");
  const [pointError, setPointError] = useState<string | null>(null);
  const [mapPickMode, setMapPickMode] = useState(false);
  const [builderPickMode, setBuilderPickMode] = useState(false);
  const [builderPoints, setBuilderPoints] = useState<BuilderPoint[]>([]);
  const [builderRouteType, setBuilderRouteType] = useState<RouteType>("roadtrip");
  const [builderSaving, setBuilderSaving] = useState(false);
  const [builderMessage, setBuilderMessage] = useState<string | null>(null);
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingRouteType, setRecordingRouteType] = useState<RouteType>("4x4");
  const [recordingStartedAt, setRecordingStartedAt] = useState<string | null>(null);
  const [recordedPoints, setRecordedPoints] = useState<RoutePoint[]>([]);
  const [recordingSaving, setRecordingSaving] = useState(false);
  const [recordingMessage, setRecordingMessage] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>("routes");
  const [mobileSheetMode, setMobileSheetMode] = useState<MobileSheetMode>("half");
  const [mobileLiveOpen, setMobileLiveOpen] = useState(false);
  const [overviewRouteIds, setOverviewRouteIds] = useState<string[]>([]);
  const [activeTrip, setActiveTrip] = useState<ActiveTrip | null>(null);
  const [tripCodeInput, setTripCodeInput] = useState("");
  const [tripMessage, setTripMessage] = useState<string | null>(null);
  const [countryFilter, setCountryFilter] = useState<"all" | RouteCountry>("all");
  const [routeTypeFilter, setRouteTypeFilter] = useState<"all" | RouteType>("all");
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loadingRoute, setLoadingRoute] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [loadingSupabaseRoutes, setLoadingSupabaseRoutes] = useState(false);
  const [supabaseRouteError, setSupabaseRouteError] = useState<string | null>(null);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [rideMode, setRideMode] = useState(false);
  const [followOwnLocation, setFollowOwnLocation] = useState(true);
  const [displayName, setDisplayName] = useState("Rijder 1");
  const [email, setEmail] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const activeRoute = routes.find((route) => route.id === activeRouteId) ?? null;
  const routeMap = useMemo(() => new Map(routes.map((route) => [route.id, route])), [routes]);
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
  const builderDirectDistanceKm = useMemo(() => routeDistanceKm(builderPoints), [builderPoints]);
  const builderDraftRoute = useMemo(
    () =>
      builderPoints.length > 1
        ? buildWaypointRoute(builderPoints, builderRouteType, builderPoints, builderDirectDistanceKm)
        : null,
    [builderDirectDistanceKm, builderPoints, builderRouteType]
  );
  const recordedDistanceKm = useMemo(() => routeDistanceKm(recordedPoints), [recordedPoints]);
  const recordingDraftRoute = useMemo(
    () =>
      recordedPoints.length > 1 ? buildRecordedRoute(recordedPoints, recordingRouteType, recordingStartedAt) : null,
    [recordedPoints, recordingRouteType, recordingStartedAt]
  );
  const visibleMapRoutes =
    activePanel === "plan"
      ? plannedRoutes
      : activePanel === "builder" && builderDraftRoute
        ? [builderDraftRoute]
        : activePanel === "record" && recordingDraftRoute
          ? [recordingDraftRoute]
          : overviewRoutes;
  const {
    supabaseConfigured,
    user,
    ownLocation,
    remoteRiders,
    error: locationError,
    demoEnabled,
    setDemoEnabled
  } = useLiveLocation({
    enabled: trackingEnabled,
    route: activeRoute,
    tripId: activeTrip?.id ?? TRIP_ID,
    displayName,
    color: "#2563eb"
  });
  const availableSamples = useMemo(() => (user && !activeTrip ? sampleRoutes : []), [activeTrip, user]);
  const filteredSamples = useMemo(
    () =>
      availableSamples.filter((route) =>
        routeMatchesFilters(
          { ...route, name: route.title },
          query,
          countryFilter,
          routeTypeFilter
        )
      ),
    [availableSamples, countryFilter, query, routeTypeFilter]
  );
  const filteredRoutes = useMemo(
    () => routes.filter((route) => routeMatchesFilters(route, query, countryFilter, routeTypeFilter)),
    [countryFilter, query, routeTypeFilter, routes]
  );
  const groupedSamples = useMemo(() => groupSamples(filteredSamples), [filteredSamples]);
  const groupedRoutes = useMemo(() => groupRoutes(filteredRoutes), [filteredRoutes]);
  const routeTypeCounts = useMemo(
    () => ({
      "4x4":
        availableSamples.filter((route) => route.routeType === "4x4").length +
        routes.filter((route) => route.routeType === "4x4").length,
      roadtrip:
        availableSamples.filter((route) => route.routeType === "roadtrip").length +
        routes.filter((route) => route.routeType === "roadtrip").length
    }),
    [availableSamples, routes]
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

  const offRouteDistanceM = useMemo(
    () => (ownLocation ? nearestRouteDistanceMeters(ownLocation, activeRoute) : null),
    [activeRoute, ownLocation]
  );
  const offRouteWarning = rideMode && offRouteDistanceM !== null && offRouteDistanceM > 75;

  useEffect(() => {
    return () => {
      if (recordingWatchIdRef.current !== null && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(recordingWatchIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadRoutes() {
      if (!user) {
        setRoutes((current) => current.filter((route) => route.source !== "supabase" && route.source !== "sample"));
        setOverviewRouteIds([]);
        setActiveRouteId(null);
        setLoadingSupabaseRoutes(false);
        return;
      }

      setLoadingSupabaseRoutes(true);
      setSupabaseRouteError(null);

      try {
        const supabaseRoutes = await loadPublicSupabaseRoutes({ tripId: activeTrip?.id });
        if (cancelled) return;

        setRoutes((current) => {
          const localRoutes = current.filter((route) => route.source !== "supabase");
          const localIds = new Set(localRoutes.map((route) => route.id));
          const nextSupabaseRoutes = supabaseRoutes.filter((route) => !localIds.has(route.id));

          return [...nextSupabaseRoutes, ...localRoutes];
        });
        setOverviewRouteIds((current) => current.filter((routeId) => supabaseRoutes.some((route) => route.id === routeId)));
        setActiveRouteId((current) => current ?? supabaseRoutes[0]?.id ?? null);
      } catch (error) {
        if (!cancelled) {
          setSupabaseRouteError(error instanceof Error ? error.message : "Routes uit Supabase konden niet laden.");
        }
      } finally {
        if (!cancelled) {
          setLoadingSupabaseRoutes(false);
        }
      }
    }

    loadRoutes();

    return () => {
      cancelled = true;
    };
  }, [activeTrip?.id, user]);

  function isMobileViewport() {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
  }

  function selectRoute(routeId: string) {
    setActiveRouteId(routeId);
  }

  function isRouteInOverview(routeId: string) {
    return overviewRouteIds.includes(routeId);
  }

  function toggleRouteInOverview(route: GpxRoute) {
    setOverviewRouteIds((current) =>
      current.includes(route.id) ? current.filter((routeId) => routeId !== route.id) : [...current, route.id]
    );
    setActiveRouteId(route.id);
  }

  function findLoadedSampleRoute(sample: SampleRoute) {
    return routes.find(
      (route) => route.source === "sample" && route.group === sample.group && route.fileName === sample.fileName
    );
  }

  async function toggleSampleInOverview(sample: SampleRoute) {
    setLoadingRoute(sample.url);
    setRouteError(null);

    try {
      const loadedRoute = await ensureSampleRoute(sample);
      toggleRouteInOverview(loadedRoute);
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Route kon niet aan het overzicht worden toegevoegd.");
    } finally {
      setLoadingRoute(null);
    }
  }

  function openPanel(panel: ActivePanel) {
    setActivePanel(panel);
    setMobileLiveOpen(false);
    if (panel !== "plan") {
      setMapPickMode(false);
    }
    if (panel !== "builder") {
      setBuilderPickMode(false);
    }
    if (isMobileViewport() && mobileSheetMode === "compact") {
      setMobileSheetMode("half");
    }
  }

  function toggleMobileLivePanel() {
    setMobileLiveOpen((current) => !current);
    if (isMobileViewport() && mobileSheetMode === "compact") {
      setMobileSheetMode("half");
    }
  }

  function handleSheetPointerDown(event: PointerEvent<HTMLButtonElement>) {
    sheetDragStartYRef.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleSheetPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const startY = sheetDragStartYRef.current;
    sheetDragStartYRef.current = null;

    if (startY === null) return;

    const deltaY = event.clientY - startY;

    if (Math.abs(deltaY) < 22) {
      setMobileSheetMode((mode) => (mode === "compact" ? "half" : "compact"));
      return;
    }

    if (deltaY < 0) {
      setMobileSheetMode((mode) => (mode === "compact" ? "half" : "expanded"));
      return;
    }

    setMobileSheetMode((mode) => (mode === "expanded" ? "half" : "compact"));
  }

  function upsertRoute(route: GpxRoute) {
    setRoutes((current) => {
      const existing = current.find((currentRoute) => currentRoute.id === route.id);
      return existing ? current : [route, ...current];
    });
    setActiveRouteId(route.id);
  }

  async function saveRouteToSupabase(route: GpxRoute) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !user) return route;

    const { data, error } = await supabase
      .from("routes")
      .insert({
        owner_id: user.id,
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

    const savedRoute = {
      ...route,
      id: data.id,
      source: "supabase" as const
    };

    if (activeTrip) {
      const { error: tripRouteError } = await supabase.from("trip_routes").upsert({
        trip_id: activeTrip.id,
        route_id: data.id,
        added_by: user.id
      });

      if (tripRouteError) throw tripRouteError;
    }

    return savedRoute;
  }

  async function createTrip() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !user) return;

    setTripMessage("Groepsrit maken...");

    const { data, error } = await supabase
      .from("trips")
      .insert({
        owner_id: user.id,
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
        user_id: user.id,
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
    setTrackingEnabled(true);
  }

  async function joinTrip() {
    const supabase = getSupabaseBrowserClient();
    const code = tripCodeInput.trim().toUpperCase();
    if (!supabase || !user || !code) return;

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
        user_id: user.id,
        role: "rider"
      },
      { onConflict: "trip_id,user_id", ignoreDuplicates: true }
    );

    if (memberError) {
      setTripMessage(memberError.message);
      return;
    }

    setActiveTrip({ id: data.id, name: data.name, shareCode: data.share_code });
    setTripMessage(`Groepsrit actief. Alleen routes van deze rit worden getoond.`);
    setRoutes([]);
    setOverviewRouteIds([]);
    setActiveRouteId(null);
    setTrackingEnabled(true);
  }

  function leaveTrip() {
    setActiveTrip(null);
    setTripMessage("Groepsrit verlaten. Je ziet weer je eigen/beschikbare routes.");
    setRoutes([]);
    setOverviewRouteIds([]);
    setActiveRouteId(null);
  }

  function exportActiveRoute() {
    if (!activeRoute) return;

    const gpx = routeToGpx(activeRoute);
    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeRoute.name.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "rallytrail-route"}.gpx`;
    link.click();
    URL.revokeObjectURL(url);
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

    setActiveRouteId(routesToAdd[0].id);
    setActivePanel("plan");
    setMapPickMode(false);
    if (isMobileViewport()) {
      setMobileSheetMode("half");
    }
  }

  async function addRouteFromText(
    text: string,
    fileName: string,
    source: GpxRoute["source"],
    options: {
      group?: string;
      country?: RouteCountry;
      routeType?: RouteType;
    } = {}
  ) {
    const parsedRoute = parseGpxRoute(text, fileName, source, {
      colorIndex: routes.length,
      group: options.group,
      country: options.country,
      routeType: options.routeType
    });
    upsertRoute(parsedRoute);
    return parsedRoute;
  }

  async function ensureSampleRoute(sample: SampleRoute) {
    const existing = routes.find(
      (route) => route.source === "sample" && route.group === sample.group && route.fileName === sample.fileName
    );

    if (existing) {
      setActiveRouteId(existing.id);
      return existing;
    }

    const response = await fetch(sample.url);
    if (!response.ok) throw new Error("Routebestand niet gevonden.");
    const text = await response.text();

    return addRouteFromText(text, sample.fileName, "sample", {
      group: sample.group,
      country: sample.country,
      routeType: sample.routeType
    });
  }

  async function loadSampleRoute(sample: SampleRoute) {
    setLoadingRoute(sample.url);
    setRouteError(null);

    try {
      await ensureSampleRoute(sample);
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Route kon niet worden geladen.");
    } finally {
      setLoadingRoute(null);
    }
  }

  function suggestedStartTime(currentItems: DayPlanItem[]) {
    if (currentItems.length === 0) return "09:00";

    const lastItem = currentItems[currentItems.length - 1];
    const lastRoute = routeMap.get(lastItem.routeId);
    if (!lastRoute || !lastItem.startTime) return "";

    return addMinutesToTime(lastItem.startTime, estimateRouteMinutes(lastRoute) + lastItem.breakMinutes);
  }

  function addRouteToPlan(route: GpxRoute) {
    addRoutesToPlan([route]);
  }

  async function addSampleToPlan(sample: SampleRoute) {
    setLoadingRoute(sample.url);
    setRouteError(null);

    try {
      const route = await ensureSampleRoute(sample);
      addRouteToPlan(route);
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Route kon niet worden toegevoegd.");
    } finally {
      setLoadingRoute(null);
    }
  }

  async function selectVisibleRoutesForOverview() {
    setLoadingRoute("overview-all");
    setRouteError(null);

    try {
      const selectedRoutes: GpxRoute[] = [...filteredRoutes];

      for (const sample of filteredSamples) {
        const route = await ensureSampleRoute(sample);
        selectedRoutes.push(route);
      }

      setOverviewRouteIds((current) => {
        const next = [...current];
        selectedRoutes.forEach((route) => {
          if (!next.includes(route.id)) {
            next.push(route.id);
          }
        });

        return next;
      });

      if (selectedRoutes[0]) {
        setActiveRouteId(selectedRoutes[0].id);
      }

      if (isMobileViewport()) {
        setMobileSheetMode("compact");
      }
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Zichtbare routes konden niet worden geselecteerd.");
    } finally {
      setLoadingRoute(null);
    }
  }

  function addOverviewToPlan() {
    addRoutesToPlan(overviewRoutes);
  }

  function sortOverviewByNearest() {
    setOverviewRouteIds(orderByNearestConnection(overviewRoutes).map((route) => route.id));
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

  function updatePlanItem(itemId: string, patch: Partial<DayPlanItem>) {
    setDayPlanItems((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
  }

  function removePlanItem(itemId: string) {
    setDayPlanItems((current) => current.filter((item) => item.id !== itemId));
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
    if (isMobileViewport()) {
      setMobileSheetMode("half");
    }
  }

  function buildPointName() {
    return pointName.trim() || mapPointLabel(pointType);
  }

  function addPointAtOwnLocation() {
    if (!ownLocation) return;

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
    const lastPoint = activeRoute?.points.at(-1);
    if (!lastPoint) return;

    addMapPoint({
      name: buildPointName(),
      type: pointType,
      lat: lastPoint.lat,
      lng: lastPoint.lng,
      note: pointNote.trim() || (activeRoute ? `Eindpunt ${activeRoute.name}` : undefined),
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

  function toggleMapPickMode() {
    setActivePanel("plan");
    setMobileLiveOpen(false);
    setBuilderPickMode(false);
    setMapPickMode((current) => !current);

    if (isMobileViewport()) {
      setMobileSheetMode("compact");
    }
  }

  function addPointFromMapClick(lat: number, lng: number) {
    if (builderPickMode) {
      addBuilderPoint(lat, lng);
      return;
    }

    if (!mapPickMode) return;

    setPointCoordinates(formatCoordinate(lat, lng));
    addMapPoint({
      name: buildPointName(),
      type: pointType,
      lat,
      lng,
      note: pointNote.trim() || undefined,
      source: "manual"
    });
  }

  function toggleBuilderPickMode() {
    setActivePanel("builder");
    setMobileLiveOpen(false);
    setMapPickMode(false);
    setBuilderPickMode((current) => !current);

    if (isMobileViewport()) {
      setMobileSheetMode("compact");
    }
  }

  function addBuilderPoint(lat: number, lng: number) {
    setBuilderPoints((current) => [
      ...current,
      {
        id: `builder-${Date.now()}-${current.length}`,
        name: `Punt ${current.length + 1}`,
        lat,
        lng
      }
    ]);
    setBuilderMessage(null);
    setActivePanel("builder");
  }

  function addOwnLocationToBuilder() {
    if (!ownLocation) return;
    addBuilderPoint(ownLocation.lat, ownLocation.lng);
  }

  function removeLastBuilderPoint() {
    setBuilderPoints((current) => current.slice(0, -1));
  }

  function clearBuilderPoints() {
    setBuilderPoints([]);
    setBuilderMessage(null);
  }

  async function createRouteFromBuilder() {
    if (builderPoints.length < 2) {
      setBuilderMessage("Voeg minimaal twee punten toe.");
      return;
    }

    setBuilderSaving(true);
    setBuilderMessage(builderRouteType === "roadtrip" ? "Route over wegen berekenen..." : "Offroad route maken...");

    try {
      const directPoints = builderPoints.map(({ lat, lng }) => ({ lat, lng }));
      const roadRoute = builderRouteType === "roadtrip" ? await buildRoadRoute(directPoints) : null;
      const draftRoute = buildWaypointRoute(
        builderPoints,
        builderRouteType,
        roadRoute?.points ?? directPoints,
        roadRoute?.distanceKm
      );
      const route = await saveRouteToSupabase(draftRoute);

      upsertRoute(route);
      setOverviewRouteIds((current) => (current.includes(route.id) ? current : [route.id, ...current]));
      setBuilderPoints([]);
      setBuilderPickMode(false);
      setBuilderMessage(
        `${routeTypeLabel(route.routeType)} route gemaakt (${formatKm(route.distanceKm)} km)${
          user ? " en opgeslagen." : ". Login om hem in Supabase te bewaren."
        }`
      );
    } catch (error) {
      setBuilderMessage(error instanceof Error ? error.message : "Route maken is mislukt.");
    } finally {
      setBuilderSaving(false);
    }
  }

  function fillCoordinatesFromOwnLocation() {
    if (!ownLocation) return;
    setPointCoordinates(formatCoordinate(ownLocation.lat, ownLocation.lng));
  }

  function fillCoordinatesFromRouteEnd() {
    const lastPoint = activeRoute?.points.at(-1);
    if (!lastPoint) return;
    setPointCoordinates(formatCoordinate(lastPoint.lat, lastPoint.lng));
  }

  function removeMapPoint(pointId: string) {
    setMapPoints((current) => current.filter((point) => point.id !== pointId));
  }

  function stopRecordingWatch() {
    if (recordingWatchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(recordingWatchIdRef.current);
      recordingWatchIdRef.current = null;
    }
    setRecordingActive(false);
  }

  function handleRecordedPosition(position: GeolocationPosition) {
    const accuracyM = position.coords.accuracy;

    if (Number.isFinite(accuracyM) && accuracyM > 50) {
      setRecordingMessage(`GPS te onnauwkeurig voor opname (+/-${Math.round(accuracyM)} m).`);
      return;
    }

    const point: RoutePoint = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      ele:
        typeof position.coords.altitude === "number" && Number.isFinite(position.coords.altitude)
          ? position.coords.altitude
          : undefined,
      time: new Date(position.timestamp).toISOString()
    };

    setRecordingMessage(null);
    setRecordedPoints((current) => {
      const previous = current.at(-1);
      if (previous && distanceKmBetween(previous, point) < 0.005) return current;

      return [...current, point];
    });
  }

  function startRecording() {
    if (!("geolocation" in navigator)) {
      setRecordingMessage("Browser-GPS wordt niet ondersteund.");
      return;
    }

    if (recordingWatchIdRef.current !== null) return;

    setActivePanel("record");
    setMobileLiveOpen(false);
    setRecordingStartedAt((current) => current ?? new Date().toISOString());
    setRecordingActive(true);
    setRecordingMessage("Opname gestart. Wachten op goede GPS...");

    recordingWatchIdRef.current = navigator.geolocation.watchPosition(
      handleRecordedPosition,
      (error) => {
        setRecordingMessage(error.message || "GPS locatie kon niet worden gelezen.");
        stopRecordingWatch();
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000
      }
    );
  }

  function pauseRecording() {
    stopRecordingWatch();
    setRecordingMessage("Opname gepauzeerd.");
  }

  function resetRecording() {
    stopRecordingWatch();
    setRecordingStartedAt(null);
    setRecordedPoints([]);
    setRecordingMessage(null);
  }

  async function saveRecordingRoute() {
    if (recordedPoints.length < 2) {
      setRecordingMessage("Rij eerst een stukje met goede GPS.");
      return;
    }

    setRecordingSaving(true);
    setRecordingMessage("Opname opslaan...");

    try {
      const draftRoute = buildRecordedRoute(recordedPoints, recordingRouteType, recordingStartedAt);
      const route = await saveRouteToSupabase(draftRoute);

      upsertRoute(route);
      setOverviewRouteIds((current) => (current.includes(route.id) ? current : [route.id, ...current]));
      resetRecording();
      setRecordingMessage(
        `Opname opgeslagen (${formatKm(route.distanceKm)} km)${user ? "." : ". Login om hem in Supabase te bewaren."}`
      );
      setActivePanel("record");
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "Opslaan van opname is mislukt.");
    } finally {
      setRecordingSaving(false);
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setRouteError(null);

    try {
      if (!user) {
        setRouteError("Log eerst in om GPX-routes te importeren.");
        return;
      }

      const text = await file.text();
      const parsedRoute = parseGpxRoute(text, file.name, "upload", {
        colorIndex: routes.length,
        group: activeTrip ? "Groepsrit route" : undefined,
        country: "Onbekend",
        routeType: "4x4"
      });
      const route = await saveRouteToSupabase(parsedRoute);
      upsertRoute(route);
      setOverviewRouteIds((current) => (current.includes(route.id) ? current : [route.id, ...current]));
      setActiveRouteId(route.id);
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "GPX import is mislukt.");
    } finally {
      event.target.value = "";
    }
  }

  async function handleMagicLink() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !email) return;

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin
      }
    });

    setAuthMessage(error ? error.message : "Magic link verstuurd.");
  }

  async function handleSignOut() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  const activeStats = activeRoute
    ? [
        { label: "Land", value: activeRoute.country, icon: Flag },
        { label: "Type", value: routeTypeLabel(activeRoute.routeType), icon: routeTypeIcon(activeRoute.routeType) },
        { label: "Afstand", value: `${formatKm(activeRoute.distanceKm)} km`, icon: RouteIcon },
        { label: "Stijgen", value: `${formatMeters(activeRoute.elevationGainM)} m`, icon: Mountain },
        { label: "Punten", value: formatMeters(activeRoute.points.length), icon: Activity },
        { label: "Live", value: `${remoteRiders.length + (ownLocation ? 1 : 0)}`, icon: Users }
      ]
    : [];
  const sheetSummary = activeRoute
    ? {
        title: activeRoute.name,
        detail: `${formatKm(activeRoute.distanceKm)} km - ${activeRoute.country} - ${routeTypeLabel(activeRoute.routeType)}`
      }
    : {
        title:
          activePanel === "routes"
            ? "Routes"
            : activePanel === "plan"
              ? "Dagschema"
              : activePanel === "builder"
                ? "Route maken"
                : "Opname",
        detail:
          activePanel === "builder"
            ? `${builderPoints.length} punten - ${formatKm(builderDirectDistanceKm)} km direct`
            : activePanel === "record"
              ? `${recordedPoints.length} punten - ${formatKm(recordedDistanceKm)} km`
              : `${dayPlanItems.length} etappes - ${formatKm(planStats.distanceKm)} km`
      };

  return (
    <main className="app-shell">
      <RouteMap
        route={activeRoute}
        visibleRoutes={visibleMapRoutes}
        mapPoints={mapPoints}
        riders={remoteRiders}
        ownLocation={ownLocation}
        followOwnLocation={followOwnLocation}
        mapPickMode={mapPickMode || builderPickMode}
        onMapClick={addPointFromMapClick}
      />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <MapPinned size={22} aria-hidden />
          </div>
          <div>
            <strong>RallyTrail</strong>
            <span>{activeRoute?.name ?? "Geen route geselecteerd"}</span>
          </div>
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className={rideMode ? "control active" : "control"}
            onClick={() => {
              setRideMode((value) => !value);
              setTrackingEnabled(true);
              setFollowOwnLocation(true);
              if (isMobileViewport()) setMobileSheetMode("compact");
            }}
            disabled={!activeRoute}
            title="Rijmodus"
          >
            <Gauge size={18} aria-hidden />
            <span>Rijden</span>
          </button>
          <button
            type="button"
            className={trackingEnabled ? "control active" : "control"}
            onClick={() => setTrackingEnabled((value) => !value)}
            title="Live tracking"
          >
            <Radio size={18} aria-hidden />
            <span>{trackingEnabled ? "Live" : "Start"}</span>
          </button>
          <button
            type="button"
            className={followOwnLocation ? "icon-button active" : "icon-button"}
            onClick={() => setFollowOwnLocation((value) => !value)}
            title="Volg eigen locatie"
          >
            <LocateFixed size={18} aria-hidden />
          </button>
        </div>
      </header>

      {(mapPickMode || builderPickMode) && (
        <div className="map-pick-banner">
          {builderPickMode ? <RouteIcon size={17} aria-hidden /> : <MapPin size={17} aria-hidden />}
          <strong>{builderPickMode ? "Waypoint toevoegen" : mapPointLabel(pointType)}</strong>
          <button
            type="button"
            onClick={() => {
              setMapPickMode(false);
              setBuilderPickMode(false);
            }}
          >
            Annuleer
          </button>
        </div>
      )}

      {rideMode && activeRoute && (
        <div className={offRouteWarning ? "ride-overlay warning" : "ride-overlay"}>
          <strong>{offRouteWarning ? "Van route" : "Rijmodus"}</strong>
          <span>
            {offRouteDistanceM === null
              ? "Wachten op GPS"
              : offRouteDistanceM < 1000
                ? `${Math.round(offRouteDistanceM)} m van route`
                : `${formatKm(offRouteDistanceM / 1000)} km van route`}
          </span>
          {ownLocation?.speedKmh ? <small>{Math.round(ownLocation.speedKmh)} km/u</small> : null}
        </div>
      )}

      <aside className={`sidebar sheet-${mobileSheetMode}${mobileLiveOpen ? " mobile-live-open" : ""}`}>
        <div className="mobile-sheet-bar">
          <button
            type="button"
            className="sheet-handle-button"
            onPointerDown={handleSheetPointerDown}
            onPointerUp={handleSheetPointerUp}
            title="Paneel slepen"
          >
            <span className="sheet-grip" aria-hidden />
            <span className="sheet-summary">
              <strong>{sheetSummary.title}</strong>
              <small>{sheetSummary.detail}</small>
            </span>
          </button>
          <div className="sheet-actions">
            <button
              type="button"
              className="icon-button mini"
              onClick={() => setMobileSheetMode("compact")}
              title="Kaartmodus"
            >
              <Minimize2 size={16} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-button mini"
              onClick={() => setMobileSheetMode((mode) => (mode === "expanded" ? "half" : "expanded"))}
              title="Paneel vergroten"
            >
              <Maximize2 size={16} aria-hidden />
            </button>
            <button
              type="button"
              className={mobileLiveOpen ? "icon-button mini active" : "icon-button mini"}
              onClick={toggleMobileLivePanel}
              title="Groep live"
            >
              <Users size={16} aria-hidden />
            </button>
          </div>
        </div>

        <section className="panel routes-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">
                {activePanel === "routes"
                  ? "Routes"
                  : activePanel === "plan"
                    ? "Planning"
                    : activePanel === "builder"
                      ? "Route maken"
                      : "Opname"}
              </span>
              <h1>
                {activePanel === "routes"
                  ? "Routebibliotheek"
                  : activePanel === "plan"
                    ? "Dagschema"
                    : activePanel === "builder"
                      ? "Waypoints"
                      : "Route opnemen"}
              </h1>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!user}
              title="GPX importeren"
            >
              <FileUp size={18} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={exportActiveRoute}
              disabled={!activeRoute}
              title="Actieve route exporteren"
            >
              <ArrowDown size={18} aria-hidden />
            </button>
            <input ref={fileInputRef} type="file" accept=".gpx,application/gpx+xml" hidden onChange={handleUpload} />
          </div>

          <div className="view-tabs">
            <button
              type="button"
              className={activePanel === "routes" ? "active" : ""}
              onClick={() => openPanel("routes")}
            >
              <Layers3 size={16} aria-hidden />
              <span>Routes</span>
            </button>
            <button
              type="button"
              className={activePanel === "plan" ? "active" : ""}
              onClick={() => openPanel("plan")}
            >
              <ListChecks size={16} aria-hidden />
              <span>Dagschema</span>
            </button>
            <button
              type="button"
              className={activePanel === "builder" ? "active" : ""}
              onClick={() => openPanel("builder")}
            >
              <RouteIcon size={16} aria-hidden />
              <span>Maken</span>
            </button>
            <button
              type="button"
              className={activePanel === "record" ? "active" : ""}
              onClick={() => openPanel("record")}
            >
              <Activity size={16} aria-hidden />
              <span>Opname</span>
            </button>
          </div>

          {activePanel === "routes" ? (
            <div className="routes-scroll">
              {!user ? (
                <div className="locked-panel">
                  <LogIn size={22} aria-hidden />
                  <strong>Login nodig</strong>
                  <span>Routes en groepsritten zijn alleen zichtbaar voor ingelogde rijders.</span>
                  <div className="auth-form stacked">
                    <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="email@domein.nl" />
                    <button type="button" className="control active" onClick={handleMagicLink}>
                      <LogIn size={16} aria-hidden />
                      <span>Stuur magic link</span>
                    </button>
                  </div>
                  {authMessage && <p className="muted-text">{authMessage}</p>}
                </div>
              ) : (
                <>
              <label className="search-field">
                <Search size={16} aria-hidden />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Zoek route" />
              </label>

              <div className="filter-stack">
                <div className="type-filter-grid">
                  {(["4x4", "roadtrip"] as RouteType[]).map((type) => {
                    const Icon = routeTypeIcon(type);

                    return (
                      <button
                        key={type}
                        type="button"
                        className={routeTypeFilter === type ? "type-filter-card active" : "type-filter-card"}
                        onClick={() => setRouteTypeFilter((current) => (current === type ? "all" : type))}
                      >
                        <Icon size={20} aria-hidden />
                        <span>{routeTypeLabel(type)}</span>
                        <small>{routeTypeCounts[type]} routes</small>
                      </button>
                    );
                  })}
                </div>
                <div className="segmented-control">
                  {COUNTRIES.map((country) => (
                    <button
                      key={country}
                      type="button"
                      className={countryFilter === country ? "active" : ""}
                      onClick={() => setCountryFilter(country)}
                    >
                      {country === "all" ? "Alle landen" : country}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overview-panel">
                <div className="overview-header">
                  <div>
                    <span className="section-label">Overzicht</span>
                    <strong>{overviewRoutes.length} routes op kaart</strong>
                    <small>
                      {formatKm(overviewStats.routeDistanceKm)} km route
                      {overviewStats.connectionDistanceKm > 0
                        ? ` - ${formatKm(overviewStats.connectionDistanceKm)} km verbinding`
                        : ""}
                    </small>
                  </div>
                  <div className="overview-actions">
                    <button
                      type="button"
                      className="icon-button mini"
                      onClick={selectVisibleRoutesForOverview}
                      disabled={loadingRoute === "overview-all"}
                      title="Zichtbare routes tonen"
                    >
                      <Eye size={16} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="icon-button mini"
                      onClick={sortOverviewByNearest}
                      disabled={overviewRoutes.length < 3}
                      title="Sorteer op dichtstbijzijnde aansluiting"
                    >
                      <RouteIcon size={16} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="icon-button mini"
                      onClick={() => setOverviewRouteIds([])}
                      disabled={overviewRoutes.length === 0}
                      title="Overzicht wissen"
                    >
                      <EyeOff size={16} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="icon-button mini"
                      onClick={addOverviewToPlan}
                      disabled={overviewRoutes.length === 0}
                      title="Overzicht toevoegen aan dagschema"
                    >
                      <ListPlus size={16} aria-hidden />
                    </button>
                  </div>
                </div>

                {overviewConnections.length > 0 && (
                  <div className="overview-connection-list">
                    {overviewConnections.map((connection, index) => (
                      <div key={connection.id} className="overview-connection-row">
                        <span>{index + 1}</span>
                        <small>
                          {connection.from} naar {connection.to}
                        </small>
                        <strong>{formatKm(connection.distanceKm)} km</strong>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {loadingSupabaseRoutes && <p className="muted-text">Supabase routes laden...</p>}

              {filteredRoutes.length > 0 && (
                <div className="loaded-routes">
                  <span className="section-label">Geimporteerd/geupload</span>
                  {sortGroupEntries(Object.entries(groupedRoutes)).map(([group, groupRoutes]) => (
                    <div key={group} className="route-group">
                      <span className="route-group-label">{group}</span>
                      {groupRoutes.map((route) => {
                        const Icon = routeTypeIcon(route.routeType);
                        const inOverview = isRouteInOverview(route.id);
                        const regionName = normalizeRegionName(route.group, route.country);

                        return (
                          <div key={route.id} className="route-row-shell">
                            <button
                              type="button"
                              className={route.id === activeRouteId ? "route-row active" : "route-row"}
                              onClick={() => selectRoute(route.id)}
                            >
                              <span className="route-color" style={{ background: route.color }} />
                              <span>
                                <strong>{route.name}</strong>
                                <small>
                                  {route.country} - {regionName} - {formatKm(route.distanceKm)} km
                                </small>
                              </span>
                              <Icon size={16} aria-hidden />
                            </button>
                            <button
                              type="button"
                              className={inOverview ? "icon-button mini active" : "icon-button mini"}
                              onClick={() => toggleRouteInOverview(route)}
                              title={inOverview ? "Verbergen in overzicht" : "Tonen in overzicht"}
                            >
                              {inOverview ? <Eye size={16} aria-hidden /> : <EyeOff size={16} aria-hidden />}
                            </button>
                            <button
                              type="button"
                              className="icon-button mini"
                              onClick={() => addRouteToPlan(route)}
                              title="Toevoegen aan dagschema"
                            >
                              <Plus size={16} aria-hidden />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              <div className="sample-list">
                {sortGroupEntries(Object.entries(groupedSamples)).map(([group, groupRoutes]) => (
                  <div key={group} className="sample-group">
                    <span className="section-label">{group}</span>
                    {groupRoutes.map((sample) => {
                      const Icon = routeTypeIcon(sample.routeType);
                      const loadedSampleRoute = findLoadedSampleRoute(sample);
                      const inOverview = loadedSampleRoute ? isRouteInOverview(loadedSampleRoute.id) : false;
                      const routeIsLoading = loadingRoute === sample.url || loadingRoute === "overview-all";
                      const regionName = normalizeRegionName(sample.group, sample.country);

                      return (
                        <div key={sample.url} className="route-row-shell">
                          <button
                            type="button"
                            className="route-row"
                            onClick={() => loadSampleRoute(sample)}
                            disabled={routeIsLoading}
                          >
                            <Icon size={16} aria-hidden />
                            <span>
                              <strong>{sample.title}</strong>
                              <small>
                                {routeIsLoading ? "Laden" : `${sample.country} - ${regionName}`}
                              </small>
                            </span>
                          </button>
                          <button
                            type="button"
                            className={inOverview ? "icon-button mini active" : "icon-button mini"}
                            onClick={() => toggleSampleInOverview(sample)}
                            disabled={routeIsLoading}
                            title={inOverview ? "Verbergen in overzicht" : "Tonen in overzicht"}
                          >
                            {inOverview ? <Eye size={16} aria-hidden /> : <EyeOff size={16} aria-hidden />}
                          </button>
                          <button
                            type="button"
                            className="icon-button mini"
                            onClick={() => addSampleToPlan(sample)}
                            disabled={routeIsLoading}
                            title="Toevoegen aan dagschema"
                          >
                            <Plus size={16} aria-hidden />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              {routeError && <p className="error-text">{routeError}</p>}
              {supabaseRouteError && <p className="error-text">{supabaseRouteError}</p>}
                </>
              )}
            </div>
          ) : activePanel === "plan" ? (
            <div className="plan-view">
              <div className="plan-summary">
                <div>
                  <CalendarDays size={17} aria-hidden />
                  <span>Etappes</span>
                  <strong>{dayPlanItems.length}</strong>
                </div>
                <div>
                  <RouteIcon size={17} aria-hidden />
                  <span>Afstand</span>
                  <strong>{formatKm(planStats.distanceKm)} km</strong>
                </div>
                <div>
                  <Mountain size={17} aria-hidden />
                  <span>Stijgen</span>
                  <strong>{formatMeters(planStats.elevationGainM)} m</strong>
                </div>
                <div>
                  <Flag size={17} aria-hidden />
                  <span>Tijd</span>
                  <strong>{formatDuration(planStats.totalMinutes)}</strong>
                </div>
              </div>

              {activeRoute && (
                <button type="button" className="control wide-control" onClick={() => addRouteToPlan(activeRoute)}>
                  <Plus size={16} aria-hidden />
                  <span>Actieve route toevoegen</span>
                </button>
              )}

              <div className="map-point-panel">
                <div className="map-point-header">
                  <div>
                    <span className="section-label">Kaartpunten</span>
                    <strong>{mapPoints.length} punten</strong>
                  </div>
                  <MapPin size={18} aria-hidden />
                </div>

                <div className="map-point-type-grid">
                  {(["overnight", "fuel", "food", "viewpoint", "repair", "note"] as MapPointType[]).map((type) => {
                    const Icon = mapPointIcon(type);

                    return (
                      <button
                        key={type}
                        type="button"
                        className={pointType === type ? "map-point-type active" : "map-point-type"}
                        onClick={() => {
                          setPointType(type);
                          if (!pointName.trim() || pointName === mapPointLabel(pointType)) {
                            setPointName(mapPointLabel(type));
                          }
                        }}
                      >
                        <Icon size={16} aria-hidden />
                        <span>{mapPointLabel(type)}</span>
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className={mapPickMode ? "control wide-control active" : "control wide-control"}
                  onClick={toggleMapPickMode}
                >
                  <Crosshair size={16} aria-hidden />
                  <span>{mapPickMode ? "Punt plaatsen actief" : "Plaats via kaart"}</span>
                </button>

                <input
                  className="plan-note"
                  value={pointName}
                  onChange={(event) => setPointName(event.target.value)}
                  placeholder="Naam punt"
                />

                <div className="coordinate-row">
                  <input
                    className="plan-note"
                    value={pointCoordinates}
                    onChange={(event) => {
                      setPointCoordinates(event.target.value);
                      setPointError(null);
                    }}
                    placeholder="GPS: 52.196562, -3.749340"
                  />
                  <button type="button" className="icon-button mini" onClick={addPointFromCoordinates} title="Punt toevoegen">
                    <Plus size={16} aria-hidden />
                  </button>
                </div>

                <input
                  className="plan-note"
                  value={pointNote}
                  onChange={(event) => setPointNote(event.target.value)}
                  placeholder="Notitie"
                />

                <div className="map-point-actions">
                  <button
                    type="button"
                    className="control"
                    onClick={addPointAtOwnLocation}
                    disabled={!ownLocation}
                  >
                    <LocateFixed size={16} aria-hidden />
                    <span>Voeg mijn locatie toe</span>
                  </button>
                  <button
                    type="button"
                    className="control"
                    onClick={addPointAtRouteEnd}
                    disabled={!activeRoute}
                  >
                    <Flag size={16} aria-hidden />
                    <span>Voeg eindpunt toe</span>
                  </button>
                </div>

                <div className="map-point-fill-actions">
                  <button type="button" onClick={fillCoordinatesFromOwnLocation} disabled={!ownLocation}>
                    GPS uit mijn locatie
                  </button>
                  <button type="button" onClick={fillCoordinatesFromRouteEnd} disabled={!activeRoute}>
                    GPS uit eindpunt
                  </button>
                </div>

                {pointError && <p className="error-text">{pointError}</p>}

                {mapPoints.length > 0 && (
                  <div className="map-point-list">
                    {mapPoints.map((point, index) => {
                      const Icon = mapPointIcon(point.type);

                      return (
                      <div key={point.id} className="map-point-row">
                        <span className={`map-point-index map-point-index-${point.type}`}>
                          <Icon size={14} aria-hidden />
                        </span>
                        <span>
                          <strong>{index + 1}. {point.name}</strong>
                          <small>
                            {mapPointLabel(point.type)} - {point.note ?? formatCoordinate(point.lat, point.lng)}
                          </small>
                        </span>
                        <button
                          type="button"
                          className="icon-button mini danger"
                          onClick={() => removeMapPoint(point.id)}
                          title="Punt verwijderen"
                        >
                          <Trash2 size={15} aria-hidden />
                        </button>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {dayPlanItems.length === 0 ? (
                <div className="empty-plan">
                  <ListChecks size={22} aria-hidden />
                  <span>Selecteer routes en voeg ze toe met de plusknop.</span>
                </div>
              ) : (
                <div className="plan-list">
                  {dayPlanItems.map((item, index) => {
                    const route = routeMap.get(item.routeId);
                    if (!route) return null;
                    const Icon = routeTypeIcon(route.routeType);

                    return (
                      <div key={item.id} className={route.id === activeRouteId ? "plan-item active" : "plan-item"}>
                        <button type="button" className="plan-route-main" onClick={() => selectRoute(route.id)}>
                          <span className="plan-index">{index + 1}</span>
                          <span className="route-color" style={{ background: route.color }} />
                          <span>
                            <strong>{route.name}</strong>
                            <small>
                              {route.country} - {routeTypeLabel(route.routeType)} - {formatKm(route.distanceKm)} km -{" "}
                              {formatDuration(estimateRouteMinutes(route))}
                            </small>
                          </span>
                          <Icon size={16} aria-hidden />
                        </button>

                        <div className="plan-controls">
                          <button
                            type="button"
                            className="icon-button mini"
                            onClick={() => movePlanItem(item.id, -1)}
                            disabled={index === 0}
                            title="Omhoog"
                          >
                            <ArrowUp size={15} aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="icon-button mini"
                            onClick={() => movePlanItem(item.id, 1)}
                            disabled={index === dayPlanItems.length - 1}
                            title="Omlaag"
                          >
                            <ArrowDown size={15} aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="icon-button mini danger"
                            onClick={() => removePlanItem(item.id)}
                            title="Verwijderen"
                          >
                            <Trash2 size={15} aria-hidden />
                          </button>
                        </div>

                        <div className="plan-fields">
                          <label>
                            <span>Start</span>
                            <input
                              type="time"
                              value={item.startTime}
                              onChange={(event) => updatePlanItem(item.id, { startTime: event.target.value })}
                            />
                          </label>
                          <label>
                            <span>Pauze</span>
                            <input
                              type="number"
                              min="0"
                              max="240"
                              step="5"
                              value={item.breakMinutes}
                              onChange={(event) =>
                                updatePlanItem(item.id, {
                                  breakMinutes: Math.max(0, Number.parseInt(event.target.value || "0", 10))
                                })
                              }
                            />
                          </label>
                        </div>

                        <input
                          className="plan-note"
                          value={item.note}
                          onChange={(event) => updatePlanItem(item.id, { note: event.target.value })}
                          placeholder="Notitie"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : activePanel === "builder" ? (
            <div className="plan-view">
              <div className="map-point-panel">
                <div className="map-point-header">
                  <div>
                    <span className="section-label">Waypoint route</span>
                    <strong>
                      {builderPoints.length} punten - {formatKm(builderDirectDistanceKm)} km direct
                    </strong>
                  </div>
                  <RouteIcon size={18} aria-hidden />
                </div>

                <div className="map-point-type-grid two-columns">
                  {(["roadtrip", "4x4"] as RouteType[]).map((type) => {
                    const Icon = routeTypeIcon(type);

                    return (
                      <button
                        key={type}
                        type="button"
                        className={builderRouteType === type ? "map-point-type active" : "map-point-type"}
                        onClick={() => setBuilderRouteType(type)}
                        disabled={builderSaving}
                      >
                        <Icon size={17} aria-hidden />
                        <span>{routeTypeLabel(type)}</span>
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className={builderPickMode ? "control wide-control active" : "control wide-control"}
                  onClick={toggleBuilderPickMode}
                  disabled={builderSaving}
                >
                  <Crosshair size={16} aria-hidden />
                  <span>{builderPickMode ? "Waypoint plaatsen actief" : "Waypoints via kaart"}</span>
                </button>

                <div className="map-point-actions">
                  <button type="button" className="control" onClick={addOwnLocationToBuilder} disabled={!ownLocation}>
                    <LocateFixed size={16} aria-hidden />
                    <span>GPS punt</span>
                  </button>
                  <button
                    type="button"
                    className="control"
                    onClick={removeLastBuilderPoint}
                    disabled={builderPoints.length === 0 || builderSaving}
                  >
                    <ArrowDown size={16} aria-hidden />
                    <span>Undo</span>
                  </button>
                </div>

                <div className="map-point-actions">
                  <button
                    type="button"
                    className="control"
                    onClick={clearBuilderPoints}
                    disabled={builderPoints.length === 0 || builderSaving}
                  >
                    <Trash2 size={16} aria-hidden />
                    <span>Wis punten</span>
                  </button>
                  <button
                    type="button"
                    className="control active"
                    onClick={createRouteFromBuilder}
                    disabled={builderPoints.length < 2 || builderSaving}
                  >
                    <RouteIcon size={16} aria-hidden />
                    <span>
                      {builderSaving
                        ? "Maken..."
                        : builderRouteType === "roadtrip"
                          ? "Maak wegenroute"
                          : "Maak offroad route"}
                    </span>
                  </button>
                </div>

                {builderMessage && <p className="muted-text">{builderMessage}</p>}
              </div>

              {builderPoints.length === 0 ? (
                <div className="empty-plan">
                  <Crosshair size={22} aria-hidden />
                  <span>Zet waypoint plaatsen aan en klik op de kaart.</span>
                </div>
              ) : (
                <div className="plan-list">
                  {builderPoints.map((point, index) => (
                    <div key={point.id} className="map-point-row">
                      <span className="plan-index">{index + 1}</span>
                      <span>
                        <strong>{point.name}</strong>
                        <small>{formatCoordinate(point.lat, point.lng)}</small>
                      </span>
                      <button
                        type="button"
                        className="icon-button mini danger"
                        onClick={() => setBuilderPoints((current) => current.filter((item) => item.id !== point.id))}
                        title="Punt verwijderen"
                      >
                        <Trash2 size={15} aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="plan-view">
              <div className="map-point-panel">
                <div className="map-point-header">
                  <div>
                    <span className="section-label">Route opnemen</span>
                    <strong>
                      {recordedPoints.length} punten - {formatKm(recordedDistanceKm)} km
                    </strong>
                  </div>
                  <Activity size={18} aria-hidden />
                </div>

                <div className="map-point-type-grid two-columns">
                  {(["4x4", "roadtrip"] as RouteType[]).map((type) => {
                    const Icon = routeTypeIcon(type);

                    return (
                      <button
                        key={type}
                        type="button"
                        className={recordingRouteType === type ? "map-point-type active" : "map-point-type"}
                        onClick={() => setRecordingRouteType(type)}
                        disabled={recordingActive || recordingSaving}
                      >
                        <Icon size={17} aria-hidden />
                        <span>{routeTypeLabel(type)}</span>
                      </button>
                    );
                  })}
                </div>

                <div className={recordingActive ? "recording-card active" : "recording-card"}>
                  <span>{recordingActive ? "Opname actief" : "Opname klaar"}</span>
                  <strong>{formatKm(recordedDistanceKm)} km</strong>
                  <small>Alleen GPS-punten met +/-50 m of beter worden opgenomen.</small>
                </div>

                <div className="map-point-actions">
                  <button
                    type="button"
                    className={recordingActive ? "control" : "control active"}
                    onClick={recordingActive ? pauseRecording : startRecording}
                    disabled={recordingSaving}
                  >
                    <Radio size={16} aria-hidden />
                    <span>{recordingActive ? "Pauzeer" : recordedPoints.length > 0 ? "Hervat" : "Start"}</span>
                  </button>
                  <button
                    type="button"
                    className="control"
                    onClick={resetRecording}
                    disabled={recordedPoints.length === 0 || recordingSaving}
                  >
                    <Trash2 size={16} aria-hidden />
                    <span>Wis</span>
                  </button>
                </div>

                <button
                  type="button"
                  className="control wide-control active"
                  onClick={saveRecordingRoute}
                  disabled={recordedPoints.length < 2 || recordingSaving}
                >
                  <FileUp size={16} aria-hidden />
                  <span>{recordingSaving ? "Opslaan..." : "Sla opname op als route"}</span>
                </button>

                {recordingMessage && <p className="muted-text">{recordingMessage}</p>}
              </div>
            </div>
          )}
        </section>

        <section className="panel status-panel">
          <div className="panel-header compact">
            <div>
              <span className="eyebrow">Rit</span>
              <h2>Groep live</h2>
            </div>
            <Users size={20} aria-hidden />
          </div>

          <label className="field">
            <span>Naam</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>

          {!supabaseConfigured ? (
            <div className="demo-box">
              <span>Demo-modus</span>
              <button
                type="button"
                className={demoEnabled ? "control active" : "control"}
                onClick={() => setDemoEnabled(!demoEnabled)}
              >
                <Crosshair size={16} aria-hidden />
                <span>{demoEnabled ? "Aan" : "Uit"}</span>
              </button>
            </div>
          ) : user ? (
            <div className="auth-row">
              <span>{user.email}</span>
              <button type="button" className="icon-button" onClick={handleSignOut} title="Uitloggen">
                <LogOut size={17} aria-hidden />
              </button>
            </div>
          ) : (
            <div className="auth-form">
              <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="email@domein.nl" />
              <button type="button" className="control" onClick={handleMagicLink}>
                <LogIn size={16} aria-hidden />
                <span>Login</span>
              </button>
            </div>
          )}

          {authMessage && <p className="muted-text">{authMessage}</p>}
          {locationError && <p className="error-text">{locationError}</p>}

          {user && (
            <div className="trip-box">
              <div>
                <span className="section-label">Groepsrit</span>
                <strong>{activeTrip ? activeTrip.name : "Geen groepsrit actief"}</strong>
                <small>
                  {activeTrip
                    ? `Code ${activeTrip.shareCode} - routebibliotheek beperkt tot deze rit`
                    : "Maak of open een ritcode voor afgeschermde routes."}
                </small>
              </div>
              <div className="auth-form stacked">
                <input
                  value={tripCodeInput}
                  onChange={(event) => setTripCodeInput(event.target.value.toUpperCase())}
                  placeholder="Ritcode"
                />
                <div className="trip-actions">
                  <button type="button" className="control" onClick={createTrip}>
                    <Plus size={16} aria-hidden />
                    <span>Nieuw</span>
                  </button>
                  <button type="button" className="control" onClick={joinTrip} disabled={!tripCodeInput.trim()}>
                    <LogIn size={16} aria-hidden />
                    <span>Join</span>
                  </button>
                  <button type="button" className="control" onClick={leaveTrip} disabled={!activeTrip}>
                    <LogOut size={16} aria-hidden />
                    <span>Uit</span>
                  </button>
                </div>
              </div>
              {tripMessage && <p className="muted-text">{tripMessage}</p>}
            </div>
          )}

          {activeRoute && (
            <div className="stats-grid">
              {activeStats.map((stat) => {
                const Icon = stat.icon;
                return (
                  <div key={stat.label} className="stat-tile">
                    <Icon size={17} aria-hidden />
                    <span>{stat.label}</span>
                    <strong>{stat.value}</strong>
                  </div>
                );
              })}
            </div>
          )}

          <div className="rider-list">
            {[ownLocation, ...remoteRiders].filter(Boolean).map((rider) => (
              <div key={rider!.userId} className="rider-row">
                <span className="rider-dot" style={{ background: rider!.color }} />
                <span>
                  <strong>{rider!.name}</strong>
                  <small>{formatRiderMeta(rider!)}</small>
                </span>
                <Gauge size={16} aria-hidden />
              </div>
            ))}
          </div>
        </section>
      </aside>
    </main>
  );
}
