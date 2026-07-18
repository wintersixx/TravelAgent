/**
 * The tools our agent can call.
 *
 * Two things live here, and it's worth keeping them straight:
 *
 *   1. SCHEMAS  - JSON descriptions we send TO the model. This is all the model
 *                 ever sees. It never sees the code below; it only knows a tool
 *                 exists, what it's for, and what arguments it takes.
 *   2. HANDLERS - the actual functions WE run when the model asks for a tool.
 *
 * The model cannot execute anything. It can only ask. We do the executing.
 * That gap is the single most important idea in agent engineering.
 *
 * Right now every handler returns hardcoded data. That's deliberate: it means
 * any bug you hit is in the loop, not in someone's flaky API.
 */

import { flightSchema, searchFlightsLive } from "./flights-live.js";
import { hotelSchema, searchHotelsLive } from "./hotels-live.js";

// ---------------------------------------------------------------------------
// 1. SCHEMAS — what the model sees
// ---------------------------------------------------------------------------
//
// search_flights and search_hotels are now REAL (SerpApi / Google Flights &
// Google Hotels) — see flights-live.ts and hotels-live.ts. search_activities is
// still fake. Nothing else in the system changed to swap a tool from fake to
// real: that's the tool abstraction earning its keep.

export const toolSchemas = [
  flightSchema,
  hotelSchema,
  {
    type: "function" as const,
    function: {
      name: "search_activities",
      description:
        "Find things to do in a city — restaurants, nightlife, culture, " +
        "photography spots. Returns options with name, category, price in GBP, " +
        "and a note on why it's interesting.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City to search, e.g. 'Kyoto'" },
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
  },
];

// ---------------------------------------------------------------------------
// 2. HANDLERS — what we actually run
// ---------------------------------------------------------------------------

// Handlers may be sync (fake tools) or async (real API calls). runTool awaits
// either, so both kinds live behind the same interface.
type Handler = (args: any) => unknown | Promise<unknown>;

// Flights and hotels are now real (searchFlightsLive / searchHotelsLive).
// Only activities remain fake below.

const searchActivities: Handler = ({ city, category }) => {
  const data: Record<string, Record<string, any[]>> = {
    tokyo: {
      food: [
        { name: "Tsukiji Outer Market", price: 25, note: "Early morning seafood, go before 9am" },
        { name: "Omoide Yokocho", price: 30, note: "Cramped yakitori alley, smoky and excellent" },
        { name: "Ichiran Ramen", price: 12, note: "Solo booths, no small talk required" },
      ],
      nightlife: [
        { name: "Golden Gai", price: 40, note: "Six alleys of tiny bars, some cover charges" },
        { name: "Contact Tokyo", price: 25, note: "Underground techno, opens late, no photos" },
        { name: "Womb Shibuya", price: 30, note: "Big room, house and techno, Fri/Sat" },
      ],
      culture: [
        { name: "Sensoji Temple", price: 0, note: "Busy but worth it at dawn" },
        { name: "teamLab Planets", price: 25, note: "Digital art, book ahead" },
      ],
      photography: [
        { name: "Shibuya Crossing (Mag's Park)", price: 5, note: "Rooftop view of the scramble" },
        { name: "Shinjuku backstreets at night", price: 0, note: "Neon reflections after rain" },
      ],
    },
    kyoto: {
      food: [
        { name: "Nishiki Market", price: 20, note: "Street food, avoid midday crush" },
        { name: "Pontocho Alley izakaya", price: 45, note: "Riverside, atmospheric" },
      ],
      nightlife: [
        { name: "Bar Rocking Chair", price: 25, note: "Cocktails, quiet, no scene" },
      ],
      culture: [
        { name: "Fushimi Inari", price: 0, note: "Go at 6am or it's a queue" },
        { name: "Nanzen-ji aqueduct", price: 5, note: "Brick arches, rarely crowded" },
      ],
      photography: [
        { name: "Arashiyama bamboo grove", price: 0, note: "Dawn only, otherwise unusable" },
      ],
    },
  };

  const cityData = data[String(city).toLowerCase()] ?? {};
  const results = cityData[String(category)] ?? [];

  return { query: { city, category }, results };
};

// ---------------------------------------------------------------------------
// 3. THE REGISTRY — maps a tool name to the function that runs it
// ---------------------------------------------------------------------------

export const toolHandlers: Record<string, Handler> = {
  search_flights: searchFlightsLive, // REAL — SerpApi / Google Flights
  search_hotels: searchHotelsLive, // REAL — SerpApi / Google Hotels
  search_activities: searchActivities, // fake
};

/**
 * Run a tool by name. The model gives us a name and a JSON string of args;
 * we look up the handler and call it.
 *
 * Note the try/catch. The model WILL eventually hallucinate a tool name or send
 * malformed arguments. When that happens we return the error as a normal result
 * rather than crashing — the model reads it and corrects itself on the next turn.
 * Errors are just more context. This is a real pattern, not a nicety.
 */
// Now async: real tools (search_flights) make network calls. We await the
// handler whether it's sync or async — awaiting a non-promise is harmless.
export async function runTool(name: string, rawArgs: string): Promise<string> {
  try {
    const handler = toolHandlers[name];
    if (!handler) {
      return JSON.stringify({ error: `No such tool: ${name}` });
    }
    const args = JSON.parse(rawArgs);
    return JSON.stringify(await handler(args));
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
