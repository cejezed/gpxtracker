import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
  type CameraRef,
  type PressEvent,
  type PressEventWithFeatures,
  type StyleSpecification
} from "@maplibre/maplibre-react-native";
import type { RealtimeChannel, Session } from "@supabase/supabase-js";
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
  StyleSheet,
  Text,
  TextInput,
  type NativeSyntheticEvent,
  View
} from "react-native";

import { formatKm, formatMeters, loadPublicRoutes } from "./src/routes";
import { buildRoadRoute } from "./src/routing";
import { isSupabaseConfigured, supabase } from "./src/supabase";
import type { GpsQuality, GpxRoute, RiderLocation, RoutePoint, RouteType } from "./src/types";

const TRIP_ID = "default-trip";
const GOOD_ACCURACY_M = 50;
const MODERATE_ACCURACY_M = 200;

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

type ActivePanel = "routes" | "planner" | "record" | "live";

function routeTypeLabel(routeType: RouteType) {
  return routeType === "roadtrip" ? "Roadtrip" : "Offroad";
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

export default function App() {
  const cameraRef = useRef<CameraRef>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [routes, setRoutes] = useState<GpxRoute[]>([]);
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("Rijder");
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [ownLocation, setOwnLocation] = useState<RiderLocation | null>(null);
  const [remoteRiders, setRemoteRiders] = useState<RiderLocation[]>([]);
  const [locationMessage, setLocationMessage] = useState("GPS starten...");
  const [activePanel, setActivePanel] = useState<ActivePanel>("routes");
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

  const activeRouteLine = useMemo(() => (activeRoute ? routeLine(activeRoute) : null), [activeRoute]);

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

  const groupedRoutes = useMemo(() => {
    return routes.reduce<Record<string, GpxRoute[]>>((groups, route) => {
      const label = route.group ?? `${route.country} - ${routeTypeLabel(route.routeType)}`;
      groups[label] = [...(groups[label] ?? []), route];
      return groups;
    }, {});
  }, [routes]);

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
  }, []);

  const handleMapPress = useCallback(
    (event: NativeSyntheticEvent<PressEvent | PressEventWithFeatures>) => {
      if (!plannerEnabled) return;

      const [lng, lat] = event.nativeEvent.lngLat;
      addPlannerPoint(lat, lng);
    },
    [addPlannerPoint, plannerEnabled]
  );

  const refreshRoutes = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setRouteError("Supabase is nog niet ingesteld voor de native app.");
      return;
    }

    setRoutesLoading(true);
    setRouteError(null);

    try {
      const publicRoutes = await loadPublicRoutes();
      setRoutes(publicRoutes);
      setActiveRouteId((current) => current ?? publicRoutes[0]?.id ?? null);
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Routes laden is mislukt.");
    } finally {
      setRoutesLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshRoutes();
    }, 0);

    return () => clearTimeout(timer);
  }, [refreshRoutes]);

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
    const channel = client.channel(`trip:${TRIP_ID}`, {
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
  }, [session]);

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
    if (!activeRoute || !cameraRef.current) return;

    const bounds = routeBounds(activeRoute.points);
    if (!Number.isFinite(bounds.west) || !Number.isFinite(bounds.south)) return;

    cameraRef.current.fitBounds([bounds.west, bounds.south, bounds.east, bounds.north], {
      padding: { top: 90, right: 40, bottom: 330, left: 40 },
      duration: 700,
      easing: "ease"
    });
  }, [activeRoute]);

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

  async function handleSignOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  function centerOnOwnLocation() {
    if (!ownLocation) {
      Alert.alert("Geen GPS", "RallyTrail heeft nog geen locatie ontvangen.");
      return;
    }

    cameraRef.current?.easeTo({
      center: [ownLocation.lng, ownLocation.lat],
      zoom: ownLocation.gpsQuality === "good" ? 15 : 13,
      duration: 500,
      easing: "ease"
    });
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
        is_public: true
      })
      .select("id")
      .single();

    if (error) throw error;

    return {
      ...route,
      id: data.id
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

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <Map
        style={styles.map}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution
        attributionPosition={{ bottom: 10, right: 10 }}
        compassPosition={{ top: 88, right: 16 }}
        onPress={handleMapPress}
      >
        <Camera ref={cameraRef} initialViewState={{ center: DEFAULT_CENTER, zoom: 9 }} />

        {activeRouteLine && activeRoute ? (
          <GeoJSONSource id="active-route" data={activeRouteLine}>
            <Layer
              id="active-route-shadow"
              type="line"
              style={{
                lineColor: "#111827",
                lineOpacity: 0.72,
                lineWidth: 8,
                lineCap: "round",
                lineJoin: "round"
              }}
            />
            <Layer
              id="active-route-line"
              type="line"
              style={{
                lineColor: activeRoute.color,
                lineWidth: 4,
                lineCap: "round",
                lineJoin: "round"
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
      </Map>

      <View style={styles.topBar}>
        <View>
          <Text style={styles.appName}>RallyTrail</Text>
          <Text style={styles.statusText}>
            {routeCount} routes | {liveCount} live
            {recordingActive ? ` | REC ${formatKm(recordedDistanceKm)} km` : ""}
          </Text>
        </View>
        <View style={styles.topActions}>
          <Pressable
            style={[styles.recordButton, recordingActive && styles.recordButtonActive]}
            onPress={() => {
              if (recordingActive) {
                pauseRecording();
              } else {
                startRecording();
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
              setPlannerEnabled((current) => !current);
              setActivePanel("planner");
            }}
          >
            <Text style={[styles.planButtonText, plannerEnabled && styles.planButtonTextActive]}>Plan</Text>
          </Pressable>
          <Pressable style={styles.locationButton} onPress={centerOnOwnLocation}>
            <Text style={styles.locationButtonText}>GPS</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.gpsBadge}>
        <Text style={[styles.gpsBadgeText, { color: markerColor(ownLocation?.gpsQuality) }]}>{locationMessage}</Text>
        <Text style={styles.gpsBadgeSub}>
          Live delen pas bij GPS goed ({GOOD_ACCURACY_M} m of beter)
        </Text>
      </View>

      <View style={styles.sheet}>
        <View style={styles.panelTabs}>
          {(["routes", "planner", "record", "live"] as ActivePanel[]).map((panel) => (
            <Pressable
              key={panel}
              style={[styles.panelTab, activePanel === panel && styles.panelTabActive]}
              onPress={() => setActivePanel(panel)}
            >
              <Text style={[styles.panelTabText, activePanel === panel && styles.panelTabTextActive]}>
                {panel === "routes"
                  ? "Routes"
                  : panel === "planner"
                    ? "Waypoints"
                    : panel === "record"
                      ? "Opname"
                      : "Live"}
              </Text>
            </Pressable>
          ))}
        </View>

        <ScrollView
          refreshControl={<RefreshControl refreshing={routesLoading} onRefresh={refreshRoutes} />}
          showsVerticalScrollIndicator={false}
        >
          {activePanel === "routes" ? (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Routes</Text>
                {routesLoading ? <ActivityIndicator color="#f97316" /> : null}
              </View>

              {routeError ? <Text style={styles.errorText}>{routeError}</Text> : null}

              {activeRoute ? (
                <View style={styles.activeCard}>
                  <Text style={styles.routeType}>{routeTypeLabel(activeRoute.routeType)}</Text>
                  <Text style={styles.activeRouteName}>{activeRoute.name}</Text>
                  <Text style={styles.routeMeta}>
                    {activeRoute.group ?? activeRoute.country} | {formatKm(activeRoute.distanceKm)} km |{" "}
                    {formatMeters(activeRoute.elevationGainM)} m stijgen
                  </Text>
                </View>
              ) : null}

              {Object.entries(groupedRoutes).map(([group, groupRoutes]) => (
                <View key={group} style={styles.routeGroup}>
                  <Text style={styles.groupTitle}>{group}</Text>
                  {groupRoutes.map((route) => {
                    const selected = route.id === activeRoute?.id;
                    return (
                      <Pressable
                        key={route.id}
                        style={[styles.routeRow, selected && styles.routeRowSelected]}
                        onPress={() => {
                          setActiveRouteId(route.id);
                          setTargetWaypointIndex(0);
                        }}
                      >
                        <View style={[styles.routeColor, { backgroundColor: route.color }]} />
                        <View style={styles.routeTextBlock}>
                          <Text style={styles.routeName} numberOfLines={1}>
                            {route.name}
                          </Text>
                          <Text style={styles.routeSub}>
                            {routeTypeLabel(route.routeType)} | {formatKm(route.distanceKm)} km
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
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

          {activePanel === "live" ? (
            <View style={styles.loginPanel}>
              <Text style={styles.sectionTitle}>Live groep</Text>
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
                </>
              ) : (
                <>
                  <Text style={styles.mutedText}>Login is nodig om je live locatie met anderen te delen.</Text>
                  <TextInput
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    placeholder="email@example.com"
                    placeholderTextColor="#6b7280"
                    style={styles.input}
                  />
                  <Pressable
                    style={[styles.primaryButton, (!isSupabaseConfigured || !email.trim()) && styles.disabledButton]}
                    disabled={!isSupabaseConfigured || !email.trim()}
                    onPress={handleMagicLink}
                  >
                    <Text style={styles.primaryButtonText}>Stuur magic link</Text>
                  </Pressable>
                </>
              )}
              {authMessage ? <Text style={styles.mutedText}>{authMessage}</Text> : null}
              {visibleRemoteRiders.length > 0 ? (
                <View style={styles.riderList}>
                  {visibleRemoteRiders.map((rider) => (
                    <Text key={rider.userId} style={styles.mutedText}>
                      {rider.name} | {gpsQualityLabel(rider.gpsQuality ?? "searching", rider.accuracyM)}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
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
    top: 48,
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 16,
    backgroundColor: "rgba(15, 23, 42, 0.92)",
    paddingHorizontal: 16,
    paddingVertical: 12
  },
  appName: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "800"
  },
  statusText: {
    color: "#cbd5e1",
    marginTop: 2
  },
  topActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  planButton: {
    minWidth: 58,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(248, 250, 252, 0.28)"
  },
  planButtonActive: {
    borderColor: "#14b8a6",
    backgroundColor: "#14b8a6"
  },
  planButtonText: {
    color: "#f8fafc",
    fontWeight: "800"
  },
  planButtonTextActive: {
    color: "#042f2e"
  },
  recordButton: {
    minWidth: 54,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(248, 250, 252, 0.28)"
  },
  recordButtonActive: {
    borderColor: "#ef4444",
    backgroundColor: "#ef4444"
  },
  recordButtonText: {
    color: "#f8fafc",
    fontWeight: "800"
  },
  recordButtonTextActive: {
    color: "#fff"
  },
  locationButton: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    backgroundColor: "#f97316"
  },
  locationButtonText: {
    color: "#111827",
    fontWeight: "800"
  },
  gpsBadge: {
    position: "absolute",
    top: 126,
    left: 16,
    right: 16,
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
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "52%",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: "#f8fafc",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 28
  },
  panelTabs: {
    flexDirection: "row",
    gap: 8,
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
    marginBottom: 8,
    textTransform: "uppercase"
  },
  routeRow: {
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
  }
});
