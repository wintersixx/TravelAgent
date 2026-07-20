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
 * All tools now call real services (they started as hardcoded fakes, which is
 * how we isolated the loop while building it — see git history / the live-*
 * modules). Flights and hotels use SerpApi; activities use free OpenStreetMap.
 */

import OpenAI from "openai";
import { flightSchema, searchFlightsLive } from "./flights-live.js";
import { hotelSchema, searchHotelsLive } from "./hotels-live.js";
import { activitySchema, searchActivitiesLive } from "./activities-live.js";
import {
  compareAirportsSchema,
  compareLondonAirports,
} from "./subagent-airports.js";
import type { Ledger } from "./verifier.js";
import type { Emit } from "./agent.js";

/**
 * Most tools are self-contained: give them args, they return data. But some
 * tools need to reach back into the running agent — the sub-agent tool makes its
 * own LLM calls, records into the shared ledger, and emits UI events. Rather
 * than make every tool take those, we pass an optional ToolContext that special
 * tools use and ordinary tools ignore.
 */
export interface ToolContext {
  client: OpenAI;
  model: string;
  ledger: Ledger;
  emit: Emit;
}

// ---------------------------------------------------------------------------
// 1. SCHEMAS — what the model sees
// ---------------------------------------------------------------------------
//
// search_flights and search_hotels are now REAL (SerpApi / Google Flights &
// Google Hotels). compare_london_airports is a SUB-AGENT (subagent-airports.ts).
// search_activities is still fake. Nothing else in the system changed to swap a
// tool from fake to real: that's the tool abstraction earning its keep.

export const toolSchemas = [
  flightSchema,
  hotelSchema,
  compareAirportsSchema,
  activitySchema,
];

// ---------------------------------------------------------------------------
// 2. HANDLERS — what we actually run
// ---------------------------------------------------------------------------

// Handlers may be sync or async (real API calls). runTool awaits either, so
// both kinds live behind the same interface.
type Handler = (args: any) => unknown | Promise<unknown>;

// All three search tools are now real: flights + hotels via SerpApi, activities
// via free OpenStreetMap. No fake data remains.

// ---------------------------------------------------------------------------
// 2. THE REGISTRY — maps a tool name to the function that runs it
// ---------------------------------------------------------------------------

export const toolHandlers: Record<string, Handler> = {
  search_flights: searchFlightsLive, // REAL — SerpApi / Google Flights
  search_hotels: searchHotelsLive, // REAL — SerpApi / Google Hotels
  search_activities: searchActivitiesLive, // REAL — OpenStreetMap (free)
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
//
// `ctx` is optional so the tool layer stays usable without a full agent (e.g.
// the tool probe). The sub-agent tool REQUIRES it; if it's missing we return a
// clean error rather than crashing.
export async function runTool(
  name: string,
  rawArgs: string,
  ctx?: ToolContext,
): Promise<string> {
  try {
    const args = JSON.parse(rawArgs);

    // The sub-agent tool is dispatched specially because it needs the context
    // (its own LLM client, the shared ledger, the event emitter) that ordinary
    // handlers never touch.
    if (name === "compare_london_airports") {
      if (!ctx) {
        return JSON.stringify({ error: "compare_london_airports requires an agent context." });
      }
      return JSON.stringify(await compareLondonAirports(args, ctx));
    }

    const handler = toolHandlers[name];
    if (!handler) {
      return JSON.stringify({ error: `No such tool: ${name}` });
    }
    return JSON.stringify(await handler(args));
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
