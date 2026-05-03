"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, LayerGroup } from "leaflet";
import type { GpxRoute, MapPoint, MapPointType, RiderLocation } from "@/lib/types";

type RouteMapProps = {
  route: GpxRoute | null;
  plannedRoutes: GpxRoute[];
  mapPoints: MapPoint[];
  riders: RiderLocation[];
  ownLocation: RiderLocation | null;
  followOwnLocation: boolean;
};

function formatRiderTooltip(rider: RiderLocation) {
  const parts = [rider.name];

  if (rider.speedKmh) {
    parts.push(`${Math.round(rider.speedKmh)} km/u`);
  }

  if (rider.accuracyM) {
    parts.push(`+/-${Math.round(rider.accuracyM)} m`);
  }

  return parts.join(" - ");
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

function mapPointLetter(type: MapPointType) {
  const letters: Record<MapPointType, string> = {
    overnight: "O",
    fuel: "B",
    food: "E",
    viewpoint: "U",
    repair: "S",
    note: "N"
  };

  return letters[type];
}

export function RouteMap({
  route,
  plannedRoutes,
  mapPoints,
  riders,
  ownLocation,
  followOwnLocation
}: RouteMapProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const routeLayerRef = useRef<LayerGroup | null>(null);
  const mapPointLayerRef = useRef<LayerGroup | null>(null);
  const riderLayerRef = useRef<LayerGroup | null>(null);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return;

    let canceled = false;

    import("leaflet").then((L) => {
      if (canceled || !mapElementRef.current) return;

      const map = L.map(mapElementRef.current, {
        zoomControl: false,
        attributionControl: false
      }).setView([51.406776, 8.61388], 9);

      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.control
        .attribution({ position: "bottomleft", prefix: false })
        .addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
        .addTo(map);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19
      }).addTo(map);

      routeLayerRef.current = L.layerGroup().addTo(map);
      mapPointLayerRef.current = L.layerGroup().addTo(map);
      riderLayerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
    });

    return () => {
      canceled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = routeLayerRef.current;
    if (!map || !layer) return;

    import("leaflet").then((L) => {
      layer.clearLayers();

      const visibleRoutes = plannedRoutes.length > 0 ? plannedRoutes : route ? [route] : [];
      if (visibleRoutes.length === 0) return;

      const allLatLngs: [number, number][] = [];

      visibleRoutes.forEach((visibleRoute, index) => {
        const latLngs = visibleRoute.points.map((point) => [point.lat, point.lng] as [number, number]);
        allLatLngs.push(...latLngs);
        const isActive = visibleRoute.id === route?.id || (!route && index === 0);

        L.polyline(latLngs, {
          color: visibleRoute.color,
          weight: isActive ? 6 : 4,
          opacity: isActive ? 0.98 : 0.62,
          lineCap: "round",
          lineJoin: "round"
        })
          .bindTooltip(`${index + 1}. ${visibleRoute.name}`)
          .addTo(layer);

        const first = visibleRoute.points[0];
        const last = visibleRoute.points[visibleRoute.points.length - 1];

        L.circleMarker([first.lat, first.lng], {
          radius: isActive ? 6 : 5,
          color: "#ffffff",
          fillColor: visibleRoute.color,
          fillOpacity: 1,
          weight: 2
        })
          .bindTooltip(`${index + 1}. start`)
          .addTo(layer);

        L.circleMarker([last.lat, last.lng], {
          radius: isActive ? 6 : 5,
          color: visibleRoute.color,
          fillColor: "#ffffff",
          fillOpacity: 1,
          weight: 2
        })
          .bindTooltip(`${index + 1}. einde`)
          .addTo(layer);

        if (isActive && visibleRoute.waypoints.length > 0) {
          visibleRoute.waypoints.forEach((waypoint) => {
            L.circleMarker([waypoint.lat, waypoint.lng], {
              radius: 5,
              color: "#111827",
              fillColor: "#f8fafc",
              fillOpacity: 1,
              weight: 2
            })
              .bindTooltip(waypoint.name)
              .addTo(layer);
          });
        }
      });

      const bounds = L.latLngBounds(allLatLngs);
      if (bounds.isValid()) {
        const isMobile = map.getSize().x <= 760;

        map.fitBounds(bounds, {
          paddingTopLeft: isMobile ? [24, 110] : [360, 110],
          paddingBottomRight: isMobile ? [24, 150] : [70, 90],
          maxZoom: 14
        });
      }
    });
  }, [plannedRoutes, route]);

  useEffect(() => {
    const layer = mapPointLayerRef.current;
    if (!layer) return;

    import("leaflet").then((L) => {
      layer.clearLayers();

      mapPoints.forEach((point, index) => {
        const icon = L.divIcon({
          className: `map-point-icon map-point-${point.type}`,
          html: `
            <span class="map-point-symbol"><span class="map-point-letter">${mapPointLetter(point.type)}</span></span>
          `,
          iconSize: [32, 32],
          iconAnchor: [16, 28]
        });

        L.marker([point.lat, point.lng], {
          icon,
          zIndexOffset: 700
        })
          .bindTooltip(`${index + 1}. ${point.name} - ${mapPointLabel(point.type)}`, {
            direction: "top",
            offset: [0, -22],
            opacity: 0.94
          })
          .addTo(layer);
      });
    });
  }, [mapPoints]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = riderLayerRef.current;
    if (!map || !layer) return;

    import("leaflet").then((L) => {
      layer.clearLayers();
      const locations = [ownLocation, ...riders].filter(Boolean) as RiderLocation[];

      locations.forEach((rider) => {
        if (rider.isSelf) {
          if (rider.accuracyM) {
            L.circle([rider.lat, rider.lng], {
              radius: rider.accuracyM,
              color: "#2563eb",
              fillColor: "#60a5fa",
              fillOpacity: 0.14,
              opacity: 0.45,
              weight: 1.5
            }).addTo(layer);
          }

          const heading =
            typeof rider.heading === "number" && Number.isFinite(rider.heading)
              ? Math.round(rider.heading)
              : null;
          const icon = L.divIcon({
            className: "self-location-icon",
            html: `
              <span class="self-location-pulse"></span>
              <span class="self-location-dot"></span>
              ${
                heading !== null
                  ? `<span class="self-location-heading" style="--heading: ${heading}deg"></span>`
                  : ""
              }
            `,
            iconSize: [34, 34],
            iconAnchor: [17, 17]
          });

          L.marker([rider.lat, rider.lng], {
            icon,
            zIndexOffset: 1000
          })
            .bindTooltip(formatRiderTooltip(rider), {
              direction: "top",
              offset: [0, -14],
              opacity: 0.92
            })
            .addTo(layer);

          return;
        }

        L.circleMarker([rider.lat, rider.lng], {
          radius: 8,
          color: "#ffffff",
          fillColor: rider.color,
          fillOpacity: 1,
          opacity: 1,
          weight: 3
        })
          .bindTooltip(formatRiderTooltip(rider), {
            direction: "top",
            offset: [0, -8],
            opacity: 0.92
          })
          .addTo(layer);
      });

      if (followOwnLocation && ownLocation) {
        map.setView([ownLocation.lat, ownLocation.lng], Math.max(map.getZoom(), 14), {
          animate: true
        });
      }
    });
  }, [followOwnLocation, ownLocation, riders]);

  return <div ref={mapElementRef} className="map-canvas" />;
}
