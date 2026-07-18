/**
 * REAL flight search, via SerpApi's Google Flights engine.
 *
 * This is the first tool that touches the real world. Everything the loop and
 * verifier do stays the same — that's the whole payoff of the tool abstraction.
 * This file's only job is: take the model's request, call a real API, and return
 * the SAME clean { results: [...] } shape the fake tool returned. The agent
 * can't tell the difference, and doesn't need to.
 *
 * Three real-world concerns this file handles that the fake tool never had to:
 *
 *   1. QUOTA. You have 200 searches/month. That's a hard, small budget. We cache
 *      identical searches to disk so re-running the same trip while testing costs
 *      zero. Forgetting this is how people burn a month's quota in an afternoon.
 *   2. AIRPORT CODES. SerpApi wants IATA codes (LHR, DUB), not "London". We push
 *      that requirement into the tool schema so the model supplies them.
 *   3. FAILURE. Missing key, blown quota, unknown route, network error — each
 *      returns a clean { error } or empty result the agent can reason about,
 *      never a crash. Errors are data (the pattern from tools.ts).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Cache ────────────────────────────────────────────────────────────────
// A dead-simple file cache keyed by the search parameters. Real production
// systems use Redis with a TTL; for learning, a JSON file on disk makes the
// mechanism visible and protects your quota. Fares do go stale, so in a real
// product you'd expire these — noted, not done.

const CACHE_DIR = join(process.cwd(), ".cache");
const CACHE_FILE = join(CACHE_DIR, "flights.json");

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
// Note the difference from the fake version: we now demand IATA codes and say
// so in the descriptions. gpt-5.4-mini-2026-03-17 knows major airport codes reliably; making
// the requirement explicit stops it from sending "London".

export const flightSchema = {
  type: "function" as const,
  function: {
    name: "search_flights",
    description:
      "Search real return flights via Google Flights. Returns options with " +
      "airline, price, total duration, and number of stops. IMPORTANT: use " +
      "3-letter IATA AIRPORT codes, not city names.",
    parameters: {
      type: "object",
      properties: {
        departure_id: {
          type: "string",
          description: "Departure airport IATA code, e.g. 'LHR' for London Heathrow",
        },
        arrival_id: {
          type: "string",
          description: "Arrival airport IATA code, e.g. 'DUB' for Dublin, 'HND' for Tokyo Haneda",
        },
        outbound_date: { type: "string", description: "Departure date, YYYY-MM-DD" },
        return_date: { type: "string", description: "Return date, YYYY-MM-DD" },
        currency: { type: "string", description: "Currency code, e.g. 'GBP'. Defaults to GBP." },
      },
      required: ["departure_id", "arrival_id", "outbound_date", "return_date"],
      additionalProperties: false,
    },
  },
};

// ── The handler ─────────────────────────────────────────────────────────────

interface FlightArgs {
  departure_id: string;
  arrival_id: string;
  outbound_date: string;
  return_date: string;
  currency?: string;
}

/**
 * Good tools tolerate messy input rather than trusting the model to be precise.
 * The model kept reaching for famous CITY codes (LON, NYC) over AIRPORT codes,
 * and Google Flights' engine rejects those. We map the common metro codes to a
 * sensible primary airport. Anything already an airport code passes straight
 * through untouched. This is cheaper and more reliable than a sterner prompt.
 */
const CITY_TO_AIRPORT: Record<string, string> = {
  LON: "LHR", // London → Heathrow
  NYC: "JFK", // New York → JFK
  TYO: "HND", // Tokyo → Haneda
  PAR: "CDG", // Paris → Charles de Gaulle
  MIL: "MXP", // Milan → Malpensa
  ROM: "FCO", // Rome → Fiumicino
  WAS: "IAD", // Washington → Dulles
  CHI: "ORD", // Chicago → O'Hare
  MOW: "SVO", // Moscow → Sheremetyevo
  OSA: "KIX", // Osaka → Kansai
};

function resolveAirport(code: string): string {
  const upper = code.trim().toUpperCase();
  return CITY_TO_AIRPORT[upper] ?? upper;
}

export async function searchFlightsLive(args: FlightArgs): Promise<unknown> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { error: "SERPAPI_KEY is not set — cannot search real flights." };
  }

  const currency = args.currency || "GBP";
  const params = {
    engine: "google_flights",
    departure_id: resolveAirport(args.departure_id),
    arrival_id: resolveAirport(args.arrival_id),
    outbound_date: args.outbound_date,
    return_date: args.return_date,
    currency,
    hl: "en",
    type: "1", // round trip
  };

  // Cache key = the search, minus the API key. Same trip → same key → no spend.
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

  // ── Map SerpApi's rich response down to our clean shape ─────────────────────
  // SerpApi returns best_flights and other_flights, each a rich nested object.
  // We flatten to the same { results: [...] } the fake tool produced, so the
  // verifier and the model see exactly the format they already know. Airline
  // names come through as real strings the verifier can check against.
  const raw = [...(data.best_flights ?? []), ...(data.other_flights ?? [])];

  if (raw.length === 0) {
    return {
      query: params,
      results: [],
      note: "No flights returned for this route/date. The route may not exist or the airport codes may be wrong.",
    };
  }

  const results = raw.slice(0, 8).map((f: any) => {
    const segments = f.flights ?? [];
    const airlines = [...new Set(segments.map((s: any) => s.airline))];
    return {
      airline: airlines.join(" + "),
      price: f.price,
      currency,
      durationHours: f.total_duration ? Math.round((f.total_duration / 60) * 10) / 10 : null,
      stops: Math.max(0, segments.length - 1),
      route: segments
        .map((s: any) => `${s.departure_airport?.id}→${s.arrival_airport?.id}`)
        .join(", "),
    };
  });

  const result = { query: params, results };

  cache[cacheKey] = result;
  saveCache(cache);

  return result;
}
