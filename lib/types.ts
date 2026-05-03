export type RouteCountry = "Engeland" | "Duitsland" | "Onbekend";

export type RouteType = "4x4" | "roadtrip";

export type MapPointType = "overnight" | "fuel" | "food" | "viewpoint" | "repair" | "note";

export type RoutePoint = {
  lat: number;
  lng: number;
  ele?: number;
  time?: string;
};

export type Waypoint = RoutePoint & {
  name: string;
};

export type GpxRoute = {
  id: string;
  name: string;
  source: "sample" | "upload";
  group?: string;
  country: RouteCountry;
  routeType: RouteType;
  fileName?: string;
  color: string;
  points: RoutePoint[];
  waypoints: Waypoint[];
  distanceKm: number;
  elevationGainM: number;
  elevationLossM: number;
};

export type RiderLocation = {
  userId: string;
  name: string;
  lat: number;
  lng: number;
  speedKmh?: number;
  heading?: number;
  accuracyM?: number;
  updatedAt: string;
  color: string;
  isSelf?: boolean;
};

export type MapPoint = {
  id: string;
  name: string;
  type: MapPointType;
  lat: number;
  lng: number;
  note?: string;
  source: "manual" | "own-location" | "route-end";
};
