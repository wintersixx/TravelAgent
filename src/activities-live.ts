/**
 * REAL activity search, via OpenStreetMap.
 *
 * The odd one out among our real tools: it's completely free — no API key, no
 * signup, no quota. OSM is open data. That's why it's the right pick for a hobby
 * project, and why activities were the natural last fake tool to replace.
 *
 * The tradeoff vs. the SerpApi tools: OSM knows WHAT exists and WHERE, but not
 * what it costs or how it's rated. So this tool returns real venue names and
 * areas but no prices. That's fine — it's a strict upgrade over the fake tool
 * (which returned nothing outside Japan), the model reasons qualitatively, and
 * the verifier confirms the names are real.
 *
 * Two free OSM services, used in sequence:
 *   1. NOMINATIM geocodes a city name → a bounding box (a lat/lon rectangle).
 *   2. OVERPASS queries that box for places tagged as bars, restaurants, etc.
 *
 * Overpass has its own query language (Overpass QL) — worth seeing once, since
 * it's a genuinely different shape from a REST call with query params.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR = join(process.cwd(), ".cache");
const CACHE_FILE = join(CACHE_DIR, "activities.json");

type Cache = Record<string, unknown>;

function loadCache(): Cache {
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    /* corrupt cache = no cache */
  }
  return {};
}
function saveCache(cache: Cache) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// OSM etiquette: they ask API users to send a real User-Agent identifying the
// app. Not optional — Nominatim will block generic/absent agents. Free service,
// so we play by their rules.
const USER_AGENT = "TravelAgentLearningProject/1.0 (hobby project)";

// ── Category → OSM tags ─────────────────────────────────────────────────────
// OSM tags places with key=value pairs. We map our four traveller-facing
// categories to the relevant tag filters. Overpass QL uses regex on values,
// which lets us match several related tags at once.
const CATEGORY_QUERY: Record<string, string> = {
  // Restaurants, cafes, and food-focused places.
  food: `nwr["amenity"~"restaurant|cafe|fast_food|food_court"](area.a);`,
  // Bars, pubs, clubs.
  nightlife: `nwr["amenity"~"bar|pub|nightclub"](area.a);`,
  // Museums, galleries, attractions, historic sites, places of worship.
  culture: `nwr["tourism"~"museum|gallery|attraction|artwork"](area.a);
            nwr["historic"](area.a);`,
  // Viewpoints and scenic spots — the closest OSM has to "photography".
  photography: `nwr["tourism"~"viewpoint|attraction"](area.a);`,
};

interface ActivityArgs {
  city: string;
  category: "food" | "nightlife" | "culture" | "photography";
}

export async function searchActivitiesLive(args: ActivityArgs): Promise<unknown> {
  const { city, category } = args;
  const cacheKey = JSON.stringify({ city: city.toLowerCase(), category });
  const cache = loadCache();
  if (cache[cacheKey]) {
    return { ...(cache[cacheKey] as object), _cached: true };
  }

  const filter = CATEGORY_QUERY[category];
  if (!filter) {
    return { error: `Unknown category: ${category}` };
  }

  // ── Step 1: Overpass can resolve a named area itself, avoiding a second
  // service. We ask it to find the area named `city`, then search within it.
  // {{geocodeArea}} isn't available on the raw API, so we use Overpass's
  // area lookup: find an area by name, bind it to `.a`, query inside it.
  const query = `
    [out:json][timeout:25];
    area["name"="${escapeQL(city)}"]["boundary"="administrative"]->.a;
    (
      ${filter}
    );
    out center 40;
  `;

  // The public Overpass server is free and consequently often busy — it returns
  // transient 429 (rate limited) and 504 (gateway timeout) under load. Those
  // clear on a retry, so we try a few times with a short backoff before giving
  // up. Retrying transient failures is standard for any real external API.
  let data: any;
  try {
    data = await overpassWithRetry(query, 3);
  } catch (err) {
    return {
      error: `Overpass unavailable after retries: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── Map OSM elements to our clean shape ─────────────────────────────────────
  // Every result must have a name (an unnamed pub is useless to recommend), so
  // we drop nameless elements. We de-dupe by name and cap the list so we don't
  // flood the model's context with 40 near-identical cafes.
  const seen = new Set<string>();
  const results: any[] = [];
  for (const el of data.elements ?? []) {
    const name = el.tags?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    results.push({
      name,
      kind: el.tags.amenity || el.tags.tourism || el.tags.historic || category,
      area: el.tags["addr:suburb"] || el.tags["addr:city"] || undefined,
      // No price/rating — OSM doesn't have them. Being explicit beats a null.
      note: buildNote(el.tags),
    });
    if (results.length >= 15) break;
  }

  const result = {
    query: { city, category },
    source: "OpenStreetMap",
    priceInfo: "OSM has no price data — names and locations only.",
    results,
  };

  if (results.length > 0) {
    cache[cacheKey] = result;
    saveCache(cache);
  }
  return result;
}

// Call Overpass, retrying transient 429/504 failures with a short backoff.
async function overpassWithRetry(query: string, attempts: number): Promise<any> {
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500 * i)); // 0, 1.5s, 3s
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
      body: query,
    });
    if (res.ok) return res.json();
    // 429/504 are transient — retry. Other codes are unlikely to improve.
    if (res.status !== 429 && res.status !== 504) {
      throw new Error(`HTTP ${res.status}`);
    }
    lastErr = `HTTP ${res.status}`;
  }
  throw new Error(lastErr);
}

// A short human note from whatever descriptive tags exist.
function buildNote(tags: Record<string, string>): string | undefined {
  const bits: string[] = [];
  if (tags.cuisine) bits.push(tags.cuisine.replace(/;/g, ", "));
  if (tags.outdoor_seating === "yes") bits.push("outdoor seating");
  if (tags.real_ale === "yes") bits.push("real ale");
  if (tags.description) bits.push(tags.description);
  return bits.length ? bits.join(" · ") : undefined;
}

// Overpass QL strings are quoted; escape embedded quotes/backslashes.
function escapeQL(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export const activitySchema = {
  type: "function" as const,
  function: {
    name: "search_activities",
    description:
      "Find real places to do things in a city via OpenStreetMap — restaurants, " +
      "nightlife (bars/pubs/clubs), culture (museums/galleries/historic sites), " +
      "or photography (viewpoints/attractions). Returns real venue names and " +
      "areas. NOTE: no prices or ratings are available from this source.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City to search, e.g. 'Dublin'" },
        category: {
          type: "string",
          enum: ["food", "nightlife", "culture", "photography"],
          description: "The kind of activity to look for",
        },
      },
      required: ["city", "category"],
      additionalProperties: false,
    },
  },
};
