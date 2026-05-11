import { createClient } from "@supabase/supabase-js";
import { XMLParser } from "fast-xml-parser";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const IMPORT_ROOTS = ["imports", "Hochsauerland", "Wales"].map((directory) => path.join(process.cwd(), directory));
const BUCKET = "gpx-routes";
const DRY_RUN = process.argv.includes("--dry-run");
const ROUTE_TYPES = new Set(["4x4", "roadtrip"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseAttributeValue: true,
  parseTagValue: false,
  trimValues: true
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanEnvValue(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

async function loadEnvFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");

    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;

      const [, key, rawValue] = match;
      if (process.env[key] === undefined) {
        process.env[key] = cleanEnvValue(rawValue);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function findGpxFiles(directory) {
  const files = [];

  async function walk(currentDirectory) {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gpx")) {
        files.push(entryPath);
      }
    }
  }

  try {
    await walk(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function pathInsideRoot(filePath, rootPath) {
  const relativePath = path.relative(rootPath, filePath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function importRootFor(filePath) {
  return IMPORT_ROOTS.find((rootPath) => pathInsideRoot(filePath, rootPath)) ?? IMPORT_ROOTS[0];
}

function relativeImportPath(filePath) {
  return path.relative(importRootFor(filePath), filePath);
}

function titleCase(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slug(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function textValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object" && "#text" in value) return textValue(value["#text"]);
  return "";
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;

  const parsed = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPoint(point) {
  if (!point || typeof point !== "object") return null;

  const lat = toNumber(point.lat);
  const lng = toNumber(point.lon ?? point.lng);

  if (lat === undefined || lng === undefined) return null;

  return {
    lat,
    lng,
    ele: toNumber(textValue(point.ele)),
    time: textValue(point.time) || undefined
  };
}

function collectTrackPoints(gpx) {
  const points = [];

  for (const track of asArray(gpx.trk)) {
    for (const segment of asArray(track?.trkseg)) {
      for (const point of asArray(segment?.trkpt)) {
        const parsed = readPoint(point);
        if (parsed) points.push(parsed);
      }
    }
  }

  return points;
}

function collectRoutePoints(gpx) {
  const points = [];

  for (const route of asArray(gpx.rte)) {
    for (const point of asArray(route?.rtept)) {
      const parsed = readPoint(point);
      if (parsed) points.push(parsed);
    }
  }

  return points;
}

function collectWaypoints(gpx) {
  const waypoints = [];

  for (const point of asArray(gpx.wpt)) {
    const parsed = readPoint(point);
    if (!parsed) continue;

    waypoints.push({
      ...parsed,
      name: textValue(point.name) || "Waypoint"
    });
  }

  return waypoints;
}

function haversineKm(a, b) {
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

function routeStats(points) {
  let distanceKm = 0;
  let elevationGainM = 0;
  let elevationLossM = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    distanceKm += haversineKm(previous, current);

    if (previous.ele !== undefined && current.ele !== undefined) {
      const diff = current.ele - previous.ele;
      if (diff > 0) elevationGainM += diff;
      if (diff < 0) elevationLossM += Math.abs(diff);
    }
  }

  return {
    distanceKm,
    elevationGainM,
    elevationLossM
  };
}

function fallbackName(fileName) {
  return titleCase(fileName.replace(/\.gpx$/i, ""));
}

function inferMetadata(filePath) {
  const rootPath = importRootFor(filePath);
  const relativePath = relativeImportPath(filePath);
  const parts = relativePath.split(path.sep);
  const rootName = path.basename(rootPath);
  const lower = `${rootName} ${relativePath}`.toLowerCase();
  const group =
    parts.length > 1
      ? titleCase(parts[0])
      : /hochsauerland/i.test(rootName)
        ? "Hoch Sauerland"
        : /wales/i.test(rootName)
          ? "Wales"
          : "Import";

  let country = "Onbekend";
  if (/(duitsland|germany|hochsauerland)/.test(lower)) {
    country = "Duitsland";
  } else if (/(engeland|wales|lake district|northumberland|uk|united kingdom|robin hood|bolton le sands)/.test(lower)) {
    country = "Engeland";
  }

  let routeType = "4x4";
  if (/(roadtrip|touring|hochsauerland|hoehenstrasse)/.test(lower)) {
    routeType = "roadtrip";
  } else if (/(offroad|off-roading|4x4|green lane|lanes|lake district|wales)/.test(lower)) {
    routeType = "4x4";
  }

  if (!ROUTE_TYPES.has(routeType)) {
    routeType = "4x4";
  }

  return {
    country,
    routeType,
    group
  };
}

function storagePathFor(filePath, metadata) {
  const relativePath = relativeImportPath(filePath);
  const parts = relativePath.split(path.sep).map((part) => slug(part) || "route");

  return [metadata.routeType, slug(metadata.country), ...parts].join("/");
}

function parseGpx(text, filePath) {
  const parsed = parser.parse(text);
  const gpx = parsed.gpx ?? parsed;
  const fileName = path.basename(filePath);
  const track = asArray(gpx.trk)[0];
  const metadata = gpx.metadata;
  const points = collectTrackPoints(gpx);
  const routePoints = points.length > 0 ? points : collectRoutePoints(gpx);

  if (routePoints.length < 2) {
    throw new Error("Te weinig routepunten in GPX-bestand.");
  }

  const stats = routeStats(routePoints);
  const waypoints = collectWaypoints(gpx);
  const name = textValue(track?.name) || textValue(metadata?.name) || fallbackName(fileName);

  return {
    name,
    fileName,
    points: routePoints,
    waypoints,
    ...stats,
    geojson: {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: routePoints.map((point) =>
          point.ele === undefined ? [point.lng, point.lat] : [point.lng, point.lat, point.ele]
        )
      },
      properties: {
        points: routePoints,
        waypoints,
        pointCount: routePoints.length,
        elevationGainM: Math.round(stats.elevationGainM),
        elevationLossM: Math.round(stats.elevationLossM),
        sourceFile: fileName
      }
    }
  };
}

async function ensureBucket(supabase) {
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (data) return;

  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    allowedMimeTypes: ["application/gpx+xml", "application/xml", "text/xml"],
    fileSizeLimit: "25MB"
  });

  if (error && !/already exists/i.test(error.message)) {
    throw error;
  }
}

async function importFile(supabase, filePath) {
  const metadata = inferMetadata(filePath);
  const text = await fs.readFile(filePath, "utf8");
  const route = parseGpx(text, filePath);
  const storagePath = storagePathFor(filePath, metadata);

  if (DRY_RUN) {
    return {
      ...route,
      metadata,
      storagePath
    };
  }

  const fileBuffer = await fs.readFile(filePath);
  const upload = await supabase.storage.from(BUCKET).upload(storagePath, fileBuffer, {
    contentType: "application/gpx+xml",
    upsert: true
  });

  if (upload.error) {
    throw upload.error;
  }

  const routeRecord = {
    owner_id: null,
    name: route.name,
    country: metadata.country,
    route_type: metadata.routeType,
    route_group: metadata.group,
    file_name: route.fileName,
    gpx_file_path: storagePath,
    geojson: route.geojson,
    distance_km: Number(route.distanceKm.toFixed(3)),
    elevation_gain_m: Math.round(route.elevationGainM),
    elevation_loss_m: Math.round(route.elevationLossM),
    is_public: true
  };

  const existing = await supabase
    .from("routes")
    .select("id")
    .eq("gpx_file_path", storagePath)
    .maybeSingle();

  if (existing.error) {
    throw existing.error;
  }

  const upsert = existing.data
    ? await supabase.from("routes").update(routeRecord).eq("id", existing.data.id)
    : await supabase.from("routes").insert(routeRecord);

  if (upsert.error) {
    throw upsert.error;
  }

  return {
    ...route,
    metadata,
    storagePath
  };
}

async function main() {
  await loadEnvFile(path.join(process.cwd(), ".env.local"));

  const nestedFiles = await Promise.all(IMPORT_ROOTS.map((rootPath) => findGpxFiles(rootPath)));
  const files = nestedFiles.flat();
  if (files.length === 0) {
    console.log("Geen GPX-bestanden gevonden in de importmappen.");
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!DRY_RUN && (!supabaseUrl || !serviceRoleKey)) {
    console.error("Ontbrekende Supabase importgegevens.");
    console.error("Zet lokaal in .env.local:");
    console.error("SUPABASE_SERVICE_ROLE_KEY=...");
    console.error("Gebruik hiervoor de Supabase service_role key, niet de anon key.");
    process.exitCode = 1;
    return;
  }

  const supabase = DRY_RUN
    ? null
    : createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      });

  if (supabase) {
    await ensureBucket(supabase);
  }

  let imported = 0;
  let failed = 0;

  for (const filePath of files) {
    try {
      const route = await importFile(supabase, filePath);
      imported += 1;
      console.log(
        `[ok] ${route.name} - ${route.metadata.country} / ${route.metadata.routeType} - ${route.distanceKm.toFixed(
          1
        )} km`
      );
    } catch (error) {
      failed += 1;
      console.error(`[fout] ${path.relative(process.cwd(), filePath)}: ${error.message}`);
    }
  }

  console.log(`${DRY_RUN ? "Gecontroleerd" : "Geimporteerd"}: ${imported}. Fouten: ${failed}.`);

  if (failed > 0) {
    console.error("Controleer of supabase/schema.sql volledig is uitgevoerd voordat je opnieuw importeert.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
