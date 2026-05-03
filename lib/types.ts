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
  updatedAt: string;
  color: string;
  isSelf?: boolean;
};
