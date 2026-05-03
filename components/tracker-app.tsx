"use client";

import {
  Activity,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Car,
  Camera,
  Crosshair,
  Flag,
  FileUp,
  Fuel,
  Gauge,
  Layers3,
  LocateFixed,
  LogIn,
  LogOut,
  ListChecks,
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
import { ChangeEvent, type PointerEvent, useMemo, useRef, useState } from "react";
import { formatKm, formatMeters, parseGpxRoute } from "@/lib/gpx";
import { sampleRoutes, type SampleRoute } from "@/lib/sample-routes";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { useLiveLocation } from "@/lib/live-location";
import type { GpxRoute, MapPoint, MapPointType, RiderLocation, RouteCountry, RouteType } from "@/lib/types";
import { RouteMap } from "@/components/route-map";

const TRIP_ID = "default-trip";
const COUNTRIES: Array<"all" | RouteCountry> = ["all", "Engeland", "Duitsland"];

type ActivePanel = "routes" | "plan";
type MobileSheetMode = "compact" | "half" | "expanded";

type DayPlanItem = {
  id: string;
  routeId: string;
  startTime: string;
  breakMinutes: number;
  note: string;
};

function groupSamples(routes: SampleRoute[]) {
  return routes.reduce<Record<string, SampleRoute[]>>((groups, route) => {
    const key = `${route.country} - ${routeTypeLabel(route.routeType)}`;
    groups[key] = [...(groups[key] ?? []), route];
    return groups;
  }, {});
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
  const [routes, setRoutes] = useState<GpxRoute[]>([]);
  const [dayPlanItems, setDayPlanItems] = useState<DayPlanItem[]>([]);
  const [mapPoints, setMapPoints] = useState<MapPoint[]>([]);
  const [pointType, setPointType] = useState<MapPointType>("overnight");
  const [pointName, setPointName] = useState("Overnachting");
  const [pointCoordinates, setPointCoordinates] = useState("");
  const [pointNote, setPointNote] = useState("");
  const [pointError, setPointError] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>("routes");
  const [mobileSheetMode, setMobileSheetMode] = useState<MobileSheetMode>("half");
  const [countryFilter, setCountryFilter] = useState<"all" | RouteCountry>("all");
  const [routeTypeFilter, setRouteTypeFilter] = useState<"all" | RouteType>("all");
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loadingRoute, setLoadingRoute] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
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
  const filteredSamples = useMemo(
    () =>
      sampleRoutes.filter((route) => {
        const matchesQuery = `${route.country} ${route.group} ${route.title} ${route.routeType}`
          .toLowerCase()
          .includes(query.toLowerCase());
        const matchesCountry = countryFilter === "all" || route.country === countryFilter;
        const matchesType = routeTypeFilter === "all" || route.routeType === routeTypeFilter;

        return matchesQuery && matchesCountry && matchesType;
      }),
    [countryFilter, query, routeTypeFilter]
  );
  const groupedSamples = useMemo(() => groupSamples(filteredSamples), [filteredSamples]);
  const routeTypeCounts = useMemo(
    () => ({
      "4x4": sampleRoutes.filter((route) => route.routeType === "4x4").length,
      roadtrip: sampleRoutes.filter((route) => route.routeType === "roadtrip").length
    }),
    []
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
    tripId: TRIP_ID,
    displayName,
    color: "#2563eb"
  });

  function isMobileViewport() {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
  }

  function selectRoute(routeId: string) {
    setActiveRouteId(routeId);
  }

  function openPanel(panel: ActivePanel) {
    setActivePanel(panel);
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
    setDayPlanItems((current) => {
      if (current.some((item) => item.routeId === route.id)) return current;

      return [
        ...current,
        {
          id: `plan-${route.id}-${Date.now()}`,
          routeId: route.id,
          startTime: suggestedStartTime(current),
          breakMinutes: current.length === 0 ? 0 : 15,
          note: ""
        }
      ];
    });
    setActiveRouteId(route.id);
    setActivePanel("plan");
    if (isMobileViewport()) {
      setMobileSheetMode("half");
    }
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

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setRouteError(null);

    try {
      const text = await file.text();
      const route = await addRouteFromText(text, file.name, "upload", {
        country: "Onbekend",
        routeType: "4x4"
      });
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
        title: activePanel === "routes" ? "Routes" : "Dagschema",
        detail: `${dayPlanItems.length} etappes - ${formatKm(planStats.distanceKm)} km`
      };

  return (
    <main className="app-shell">
      <RouteMap
        route={activeRoute}
        plannedRoutes={activePanel === "plan" ? plannedRoutes : []}
        mapPoints={mapPoints}
        riders={remoteRiders}
        ownLocation={ownLocation}
        followOwnLocation={followOwnLocation}
      />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <MapPinned size={22} aria-hidden />
          </div>
          <div>
            <strong>GPX Tracker</strong>
            <span>{activeRoute?.name ?? "Geen route geselecteerd"}</span>
          </div>
        </div>

        <div className="topbar-actions">
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

      <aside className={`sidebar sheet-${mobileSheetMode}`}>
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
          </div>
        </div>

        <section className="panel routes-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">{activePanel === "routes" ? "Routes" : "Planning"}</span>
              <h1>{activePanel === "routes" ? "Routebibliotheek" : "Dagschema"}</h1>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => fileInputRef.current?.click()}
              title="GPX importeren"
            >
              <FileUp size={18} aria-hidden />
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
          </div>

          {activePanel === "routes" ? (
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

              {routes.length > 0 && (
                <div className="loaded-routes">
                  <span className="section-label">Geladen</span>
                  {routes.map((route) => {
                    const Icon = routeTypeIcon(route.routeType);

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
                              {route.country} - {routeTypeLabel(route.routeType)} - {formatKm(route.distanceKm)} km
                            </small>
                          </span>
                          <Icon size={16} aria-hidden />
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
              )}

              <div className="sample-list">
                {Object.entries(groupedSamples).map(([group, groupRoutes]) => (
                  <div key={group} className="sample-group">
                    <span className="section-label">{group}</span>
                    {groupRoutes.map((sample) => {
                      const Icon = routeTypeIcon(sample.routeType);

                      return (
                        <div key={sample.url} className="route-row-shell">
                          <button
                            type="button"
                            className="route-row"
                            onClick={() => loadSampleRoute(sample)}
                            disabled={loadingRoute === sample.url}
                          >
                            <Icon size={16} aria-hidden />
                            <span>
                              <strong>{sample.title}</strong>
                              <small>
                                {loadingRoute === sample.url ? "Laden" : `${sample.country} - ${sample.group}`}
                              </small>
                            </span>
                          </button>
                          <button
                            type="button"
                            className="icon-button mini"
                            onClick={() => addSampleToPlan(sample)}
                            disabled={loadingRoute === sample.url}
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
            </>
          ) : (
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
