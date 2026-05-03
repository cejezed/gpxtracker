"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, LayerGroup } from "leaflet";
import type { GpxRoute, RiderLocation } from "@/lib/types";

type RouteMapProps = {
  route: GpxRoute | null;
  riders: RiderLocation[];
  ownLocation: RiderLocation | null;
  followOwnLocation: boolean;
};

export function RouteMap({
  route,
  riders,
  ownLocation,
  followOwnLocation
}: RouteMapProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const routeLayerRef = useRef<LayerGroup | null>(null);
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

      if (!route) return;

      const latLngs = route.points.map((point) => [point.lat, point.lng] as [number, number]);
      L.polyline(latLngs, {
        color: route.color,
        weight: 5,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round"
      }).addTo(layer);

      if (route.waypoints.length > 0) {
        route.waypoints.forEach((waypoint) => {
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

      const bounds = L.latLngBounds(latLngs);
      if (bounds.isValid()) {
        map.fitBounds(bounds, {
          paddingTopLeft: [360, 110],
          paddingBottomRight: [70, 90],
          maxZoom: 14
        });
      }
    });
  }, [route]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = riderLayerRef.current;
    if (!map || !layer) return;

    import("leaflet").then((L) => {
      layer.clearLayers();
      const locations = [ownLocation, ...riders].filter(Boolean) as RiderLocation[];

      locations.forEach((rider) => {
        const marker = L.circleMarker([rider.lat, rider.lng], {
          radius: rider.isSelf ? 9 : 8,
          color: "#ffffff",
          fillColor: rider.color,
          fillOpacity: 1,
          opacity: 1,
          weight: 3
        }).addTo(layer);

        marker.bindTooltip(
          `${rider.name}${rider.speedKmh ? ` - ${Math.round(rider.speedKmh)} km/u` : ""}`,
          {
            direction: "top",
            offset: [0, -8],
            opacity: 0.92
          }
        );
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
