import { useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel, User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import type { GpxRoute, RiderLocation, RoutePoint } from "@/lib/types";

type UseLiveLocationArgs = {
  enabled: boolean;
  route: GpxRoute | null;
  tripId: string;
  displayName: string;
  color: string;
};

type PresenceState = {
  userId: string;
  name: string;
  lat: number;
  lng: number;
  speedKmh?: number;
  heading?: number;
  accuracyM?: number;
  color: string;
  updatedAt: string;
};

const MAX_ACCEPTED_ACCURACY_M = 200;
const MAX_POSITION_AGE_MS = 30_000;
const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 20_000
};

function demoPoint(route: GpxRoute | null, offset: number): RoutePoint | null {
  if (!route || route.points.length === 0) return null;
  const index = Math.min(route.points.length - 1, Math.floor(route.points.length * offset));
  return route.points[index];
}

function useDemoRiders(route: GpxRoute | null, enabled: boolean) {
  return useMemo<RiderLocation[]>(() => {
    if (!enabled || !route) return [];

    const riderSeeds = [
      { userId: "demo-1", name: "Rijder 2", color: "#14b8a6", offset: 0.18 },
      { userId: "demo-2", name: "Rijder 3", color: "#a855f7", offset: 0.34 },
      { userId: "demo-3", name: "Rijder 4", color: "#eab308", offset: 0.52 }
    ];

    return riderSeeds.flatMap((seed) => {
      const point = demoPoint(route, seed.offset);
      if (!point) return [];

      return {
        userId: seed.userId,
        name: seed.name,
        color: seed.color,
        lat: point.lat,
        lng: point.lng,
        speedKmh: 24 + Math.round(seed.offset * 20),
        heading: 0,
        updatedAt: new Date().toISOString()
      };
    });
  }, [enabled, route]);
}

export function useLiveLocation({
  enabled,
  route,
  tripId,
  displayName,
  color
}: UseLiveLocationArgs) {
  const supabase = getSupabaseBrowserClient();
  const [user, setUser] = useState<User | null>(null);
  const [ownLocation, setOwnLocation] = useState<RiderLocation | null>(null);
  const [remoteRiders, setRemoteRiders] = useState<RiderLocation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [demoEnabled, setDemoEnabled] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastAcceptedLocationRef = useRef<RiderLocation | null>(null);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null));
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !navigator.geolocation) {
      return;
    }

    const handlePosition = (position: GeolocationPosition) => {
      const accuracyM =
        typeof position.coords.accuracy === "number" && Number.isFinite(position.coords.accuracy)
          ? position.coords.accuracy
          : undefined;
      const positionAgeMs = Date.now() - position.timestamp;

      if (positionAgeMs > MAX_POSITION_AGE_MS) {
        setError("GPS gaf een oude locatie door. Wacht op een nieuwe fix.");
        return;
      }

      if (accuracyM !== undefined && accuracyM > MAX_ACCEPTED_ACCURACY_M) {
        setError(
          `GPS nauwkeurigheid is te laag (+/-${Math.round(
            accuracyM
          )} m). Zet exacte locatie aan en gebruik de app buiten.`
        );
        return;
      }

      const nextLocation: RiderLocation = {
        userId: user?.id ?? "local-user",
        name: displayName,
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        speedKmh:
          typeof position.coords.speed === "number" && position.coords.speed !== null
            ? Math.max(0, position.coords.speed * 3.6)
            : undefined,
        heading:
          typeof position.coords.heading === "number" && position.coords.heading !== null
            ? position.coords.heading
            : undefined,
        accuracyM,
        updatedAt: new Date(position.timestamp).toISOString(),
        color,
        isSelf: true
      };

      lastAcceptedLocationRef.current = nextLocation;
      setOwnLocation(nextLocation);
      setError(null);
    };

    navigator.geolocation.getCurrentPosition(
      handlePosition,
      (locationError) => {
        setError(locationError.message);
      },
      GEOLOCATION_OPTIONS
    );

    const watchId = navigator.geolocation.watchPosition(
      handlePosition,
      (locationError) => {
        if (lastAcceptedLocationRef.current) {
          setOwnLocation(lastAcceptedLocationRef.current);
        }

        setError(locationError.message);
      },
      GEOLOCATION_OPTIONS
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [color, displayName, enabled, user?.id]);

  useEffect(() => {
    if (!supabase || !user || !enabled) {
      return;
    }

    let active = true;
    const channel = supabase.channel(`trip:${tripId}`, {
      config: {
        presence: {
          key: user.id
        }
      }
    });
    channelRef.current = channel;

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<PresenceState>();
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
          isSelf: key === user.id
        }))
      );

      setRemoteRiders(riders.filter((rider) => rider.userId !== user.id));
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" && active) {
        setRemoteRiders([]);
      }
    });

    return () => {
      active = false;
      channel.untrack();
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [
    enabled,
    supabase,
    tripId,
    user
  ]);

  useEffect(() => {
    if (!channelRef.current || !user || !ownLocation) return;

    channelRef.current.track({
      userId: user.id,
      name: displayName,
      lat: ownLocation.lat,
      lng: ownLocation.lng,
      speedKmh: ownLocation.speedKmh,
      heading: ownLocation.heading,
      accuracyM: ownLocation.accuracyM,
      updatedAt: ownLocation.updatedAt,
      color
    });
  }, [color, displayName, ownLocation, user]);

  const demoRiders = useDemoRiders(route, demoEnabled);

  return {
    supabaseConfigured: Boolean(supabase),
    user,
    ownLocation,
    remoteRiders: supabase && user ? remoteRiders : demoRiders,
    error,
    demoEnabled,
    setDemoEnabled
  };
}
