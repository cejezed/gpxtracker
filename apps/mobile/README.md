# RallyTrail Mobile

Native Android/iOS app for RallyTrail. The app uses the existing Supabase project and route tables from the Next.js version, but runs location tracking through native Expo APIs.

## App Identity

- App name: `RallyTrail`
- Android package: `com.brikx.rallytrail`
- iOS bundle id: `com.brikx.rallytrail`
- Deep-link scheme: `rallytrail://`

## Environment

Create `apps/mobile/.env.local` with the public Supabase values:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_OSRM_BASE_URL=https://router.project-osrm.org
```

The Supabase values can use the same Supabase URL and anon key as the web app. The OSRM value is optional; if omitted, RallyTrail uses the public OSRM demo server.

## Supabase Auth

In Supabase, add this redirect URL:

```text
rallytrail://auth
```

Path: `Authentication` -> `URL Configuration` -> `Redirect URLs`.

The current mobile login flow sends a magic link and handles the callback through the `rallytrail://auth` deep link.

## Running Locally

From the repository root:

```bash
npm run mobile:start
```

Because the app uses MapLibre as a native map module, use a development build for real device testing. Expo Go is not enough for the final GPS/map test.

## Waypoint Planning

The mobile app includes a first waypoint navigation flow without Google Maps:

- Turn on `Waypoints` mode.
- Choose `Roadtrip` for road routing or `Offroad` for direct point-to-point routing.
- Tap the map or add the current GPS point.
- Create a route from the selected points.
- Follow the next waypoint with straight-line distance and bearing.

If the rider is logged in, the route is saved to Supabase as a public route. Without login, the route is only available in the current app session.

Roadtrip routes are calculated over roads through OSRM using OpenStreetMap data. Offroad routes intentionally remain direct lines between selected points, because offroad tracks are often not routeable roads. The public OSRM demo server is suitable for light testing only; for heavier use, use a hosted or self-hosted OSRM/GraphHopper/Valhalla endpoint.

## Route Recording

The mobile app can record a route from the native GPS stream:

- Open `Opname`.
- Choose `Offroad` or `Roadtrip`.
- Start recording and drive the route.
- Only good GPS fixes are stored in the track.
- Save the recording as a normal RallyTrail route.

If the rider is logged in, the recorded route is saved to Supabase. Without login, the route remains local to the current app session.

## Android Build

Install and log in to EAS CLI, then run from `apps/mobile`:

```bash
npx eas-cli@latest login
npx eas-cli@latest env:create --environment production --name EXPO_PUBLIC_SUPABASE_URL --value https://your-project.supabase.co --visibility plaintext --force
npx eas-cli@latest env:create --environment production --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value your-anon-key --visibility plaintext --force
npx eas-cli@latest env:create --environment production --name EXPO_PUBLIC_OSRM_BASE_URL --value https://router.project-osrm.org --visibility plaintext --force
```

Only add public `EXPO_PUBLIC_` values to EAS. Do not add the Supabase service-role key to the mobile app or EAS.

For an internal APK test:

```bash
npx eas build --platform android --profile preview
```

For Play Store upload:

```bash
npx eas build --platform android --profile production
```

The production profile creates an Android App Bundle for Play Console.
