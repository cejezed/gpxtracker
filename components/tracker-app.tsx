"use client";

import {
  Activity,
  Crosshair,
  FileUp,
  Gauge,
  Layers3,
  LocateFixed,
  LogIn,
  LogOut,
  MapPinned,
  Mountain,
  Radio,
  Route as RouteIcon,
  Search,
  Users
} from "lucide-react";
import { ChangeEvent, useMemo, useRef, useState } from "react";
import { formatKm, formatMeters, parseGpxRoute } from "@/lib/gpx";
import { sampleRoutes, type SampleRoute } from "@/lib/sample-routes";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { useLiveLocation } from "@/lib/live-location";
import type { GpxRoute } from "@/lib/types";
import { RouteMap } from "@/components/route-map";

const TRIP_ID = "default-trip";

function groupSamples(routes: SampleRoute[]) {
  return routes.reduce<Record<string, SampleRoute[]>>((groups, route) => {
    groups[route.group] = [...(groups[route.group] ?? []), route];
    return groups;
  }, {});
}

export function TrackerApp() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [routes, setRoutes] = useState<GpxRoute[]>([]);
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
  const filteredSamples = useMemo(
    () =>
      sampleRoutes.filter((route) =>
        `${route.group} ${route.title}`.toLowerCase().includes(query.toLowerCase())
      ),
    [query]
  );
  const groupedSamples = useMemo(() => groupSamples(filteredSamples), [filteredSamples]);

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

  async function addRouteFromText(text: string, fileName: string, source: GpxRoute["source"], group?: string) {
    const parsedRoute = parseGpxRoute(text, fileName, source, routes.length, group);
    setRoutes((current) => {
      const existing = current.find((route) => route.id === parsedRoute.id);
      return existing ? current : [parsedRoute, ...current];
    });
    setActiveRouteId(parsedRoute.id);
  }

  async function loadSampleRoute(sample: SampleRoute) {
    setLoadingRoute(sample.url);
    setRouteError(null);

    try {
      const response = await fetch(sample.url);
      if (!response.ok) throw new Error("Routebestand niet gevonden.");
      const text = await response.text();
      await addRouteFromText(text, sample.fileName, "sample", sample.group);
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Route kon niet worden geladen.");
    } finally {
      setLoadingRoute(null);
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setRouteError(null);

    try {
      const text = await file.text();
      await addRouteFromText(text, file.name, "upload");
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
        { label: "Afstand", value: `${formatKm(activeRoute.distanceKm)} km`, icon: RouteIcon },
        { label: "Stijgen", value: `${formatMeters(activeRoute.elevationGainM)} m`, icon: Mountain },
        { label: "Punten", value: formatMeters(activeRoute.points.length), icon: Activity },
        { label: "Live", value: `${remoteRiders.length + (ownLocation ? 1 : 0)}`, icon: Users }
      ]
    : [];

  return (
    <main className="app-shell">
      <RouteMap
        route={activeRoute}
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

      <aside className="sidebar">
        <section className="panel routes-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Routes</span>
              <h1>Offroad bibliotheek</h1>
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

          <label className="search-field">
            <Search size={16} aria-hidden />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Zoek route" />
          </label>

          {routes.length > 0 && (
            <div className="loaded-routes">
              <span className="section-label">Geladen</span>
              {routes.map((route) => (
                <button
                  key={route.id}
                  type="button"
                  className={route.id === activeRouteId ? "route-row active" : "route-row"}
                  onClick={() => setActiveRouteId(route.id)}
                >
                  <span className="route-color" style={{ background: route.color }} />
                  <span>
                    <strong>{route.name}</strong>
                    <small>{formatKm(route.distanceKm)} km</small>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="sample-list">
            {Object.entries(groupedSamples).map(([group, groupRoutes]) => (
              <div key={group} className="sample-group">
                <span className="section-label">{group}</span>
                {groupRoutes.map((sample) => (
                  <button
                    key={sample.url}
                    type="button"
                    className="route-row"
                    onClick={() => loadSampleRoute(sample)}
                    disabled={loadingRoute === sample.url}
                  >
                    <Layers3 size={16} aria-hidden />
                    <span>
                      <strong>{sample.title}</strong>
                      <small>{loadingRoute === sample.url ? "Laden" : "GPX"}</small>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          {routeError && <p className="error-text">{routeError}</p>}
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
                  <small>
                    {rider!.speedKmh ? `${Math.round(rider!.speedKmh)} km/u` : "online"}
                  </small>
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
