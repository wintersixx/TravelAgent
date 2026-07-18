/**
 * REAL hotel search, via SerpApi's Google Hotels engine.
 *
 * Same pattern as flights-live.ts — take the model's request, call a real API,
 * return the clean { results: [...] } shape the rest of the system expects. If
 * you understood flights, you already understand this file.
 *
 * QUOTA WARNING: unlike OSM (free) alternatives, every hotel search here spends
 * one of your ~250 SerpApi searches — ON TOP of the flight search for the same
 * trip. So a single trip plan can cost 2+ searches. The disk cache is doing
 * even more work than it did for flights: re-running the same trip while testing
 * costs zero. Watch the cache file to see real spend.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR = join(process.cwd(), ".cache");
const CACHE_FILE = join(CACHE_DIR, "hotels.json");

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

// ── The tool schema the model sees ─────────────────────────────────────────
// Note this is a drop-in replacement for the old fake search_hotels schema:
// same tool name, similar params, so the model uses it exactly as before. The
// only real change is that maxPricePerNight now filters real listings.

export const hotelSchema = {
  type: "function" as const,
  function: {
    name: "search_hotels",
    description:
      "Search real hotels via Google Hotels for a city and date range. Returns " +
      "options with name, price per night, rating, class, and key amenities.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City or area to search, e.g. 'Dublin' or 'Shibuya, Tokyo'" },
        checkIn: { type: "string", description: "Check-in date, YYYY-MM-DD" },
        checkOut: { type: "string", description: "Check-out date, YYYY-MM-DD" },
        maxPricePerNight: {
          type: "number",
          description: "Optional cap on nightly price, in the requested currency",
        },
        currency: { type: "string", description: "Currency code, e.g. 'GBP'. Defaults to GBP." },
      },
      required: ["city", "checkIn", "checkOut"],
      additionalProperties: false,
    },
  },
};

// ── The handler ─────────────────────────────────────────────────────────────

interface HotelArgs {
  city: string;
  checkIn: string;
  checkOut: string;
  maxPricePerNight?: number;
  currency?: string;
}

export async function searchHotelsLive(args: HotelArgs): Promise<unknown> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { error: "SERPAPI_KEY is not set — cannot search real hotels." };
  }

  const currency = args.currency || "GBP";

  // Params that define the search (and thus the cache key). max_price is passed
  // to the API when given, so the cache key includes it too.
  const params: Record<string, string> = {
    engine: "google_hotels",
    q: args.city,
    check_in_date: args.checkIn,
    check_out_date: args.checkOut,
    currency,
    gl: "gb",
    hl: "en",
    sort_by: "3", // lowest price first — the model can still weigh from there
  };
  if (typeof args.maxPricePerNight === "number") {
    params.max_price = String(args.maxPricePerNight);
  }

  const cacheKey = JSON.stringify(params);
  const cache = loadCache();
  if (cache[cacheKey]) {
    return { ...(cache[cacheKey] as object), _cached: true };
  }

  // ── The real call ─────────────────────────────────────────────────────────
  const url = new URL("https://serpapi.com/search");
  Object.entries({ ...params, api_key: apiKey }).forEach(([k, v]) =>
    url.searchParams.set(k, v),
  );

  let data: any;
  try {
    const res = await fetch(url);
    data = await res.json();
    if (!res.ok || data.error) {
      return { error: `SerpApi error: ${data.error ?? res.statusText}` };
    }
  } catch (err) {
    return { error: `Network error calling SerpApi: ${err instanceof Error ? err.message : String(err)}` };
  }

  // ── Map to our clean shape ──────────────────────────────────────────────────
  // Google Hotels returns a rich 'properties' array (hotels AND vacation
  // rentals). We keep hotels, take the numeric price from extracted_lowest, and
  // trim amenities so we don't flood the model's context with 30 bullet points.
  const props = (data.properties ?? []).filter((p: any) => p.type !== "vacation rental");

  if (props.length === 0) {
    return {
      query: { city: args.city, checkIn: args.checkIn, checkOut: args.checkOut, currency },
      results: [],
      note: "No hotels returned for this city/date range.",
    };
  }

  const results = props.slice(0, 8).map((p: any) => ({
    name: p.name,
    pricePerNight: p.rate_per_night?.extracted_lowest ?? null,
    currency,
    rating: p.overall_rating ?? null,
    reviews: p.reviews ?? null,
    hotelClass: p.hotel_class ?? null,
    amenities: Array.isArray(p.amenities) ? p.amenities.slice(0, 5) : [],
  }));

  const result = {
    query: { city: args.city, checkIn: args.checkIn, checkOut: args.checkOut, currency },
    results,
  };

  cache[cacheKey] = result;
  saveCache(cache);

  return result;
}
