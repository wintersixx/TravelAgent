/**
 * A REAL SUB-AGENT: the London airport comparer.
 *
 * This is the multi-agent step, and it's worth being precise about what makes it
 * "multi-agent" rather than just "a function that loops":
 *
 *   - It runs its OWN LLM loop, with its OWN conversation array. That
 *     conversation is completely separate from the parent's. The parent never
 *     sees it.
 *   - It has its OWN, NARROWER toolset: just single-airport flight search. It
 *     can't book hotels or plan itineraries. A sub-agent is focused on purpose.
 *   - It returns a SMALL CONCLUSION, not its raw work. The parent asked "which
 *     London airport is best for this trip?" and gets back a paragraph — not the
 *     40 flight objects the sub-agent waded through to decide.
 *
 * THAT LAST POINT IS THE WHOLE REASON MULTI-AGENT EXISTS. It's context
 * isolation. Five airports × ~8 flights = a wall of data. If that landed in the
 * parent's conversation it would bloat every subsequent turn and distract the
 * planner. Here it's confined to the sub-agent's context, which is discarded
 * once it returns. People describe sub-agents as "delegation" or "a team of
 * agents"; mechanically, it's a way to keep a big pile of tokens out of the main
 * thread.
 *
 * The one wire that crosses the boundary on purpose: the flights the sub-agent
 * finds are recorded into the PARENT's ledger. Otherwise the verifier would
 * later flag the recommended flight as unverified — the parent would be
 * "claiming" a flight it never personally searched for. Ground truth is shared;
 * conversation is not.
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { flightSchema, searchFlightsLive } from "./flights-live.js";
import type { Ledger } from "./verifier.js";
import type { Emit } from "./agent.js";

// The London airports the sub-agent considers. Each with a note the sub-agent
// can factor into its reasoning — a real airport comparison isn't just price.
const LONDON_AIRPORTS: { code: string; name: string; note: string }[] = [
  { code: "LHR", name: "Heathrow", note: "Biggest, most destinations, ~45min to centre via Piccadilly/Express" },
  { code: "LGW", name: "Gatwick", note: "South, ~30min via Gatwick Express, lots of budget carriers" },
  { code: "STN", name: "Stansted", note: "Northeast, ~50min, Ryanair hub, cheap but far" },
  { code: "LTN", name: "Luton", note: "North, ~50min, easyJet/Wizz, cheap but far" },
  { code: "LCY", name: "City", note: "Docklands, closest to centre, small, business-focused, pricier" },
];

const SUB_MAX_TURNS = 8;

export interface CompareAirportsArgs {
  arrival_id: string;
  outbound_date: string;
  return_date: string;
  currency?: string;
  /** What the traveller cares about, so the sub-agent can weigh accordingly. */
  priorities?: string;
}

/**
 * Runs the sub-agent. Note the parameters it needs that a normal tool doesn't:
 * a `client` (it makes its own LLM calls), the parent `ledger` (shared ground
 * truth), and `emit` (so the UI can show it working). These are threaded in
 * through the tool-execution context — see tools.ts.
 */
export async function compareLondonAirports(
  args: CompareAirportsArgs,
  ctx: { client: OpenAI; model: string; ledger: Ledger; emit: Emit },
): Promise<unknown> {
  const { client, model, ledger, emit } = ctx;
  const currency = args.currency || "GBP";

  emit({
    type: "subagent_start",
    name: "London airport comparison",
    detail: `Comparing ${LONDON_AIRPORTS.length} airports → ${args.arrival_id}`,
  });

  // ── The sub-agent's OWN conversation. Separate universe from the parent. ──
  const subSystem = `You are a flight comparison specialist. Your only job: find
the best London-area airport to fly from for one specific trip.

There are five London airports: ${LONDON_AIRPORTS.map((a) => `${a.code} (${a.name}: ${a.note})`).join("; ")}.

Search flights from EACH airport using the search_flights tool (you may call it
for several airports at once). Then compare the results and recommend the single
best option, weighing price against convenience and travel time. The traveller's
priorities: ${args.priorities || "balance of price and convenience"}.

When done, stop calling tools and write a short recommendation (3-5 sentences):
name the winning airport, its airline and price, and briefly why it beats the
others. Mention the runner-up. Only cite airlines and prices the tool actually
returned.`;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: subSystem },
    {
      role: "user",
      content: `Trip: London → ${args.arrival_id}, out ${args.outbound_date}, back ${args.return_date}, in ${currency}. Find the best departure airport.`,
    },
  ];

  // The sub-agent's narrow toolset: single-airport flight search only.
  const subTools = [flightSchema] as ChatCompletionTool[];

  for (let turn = 1; turn <= SUB_MAX_TURNS; turn++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: subTools,
    });
    const message = response.choices[0].message;
    messages.push(message);

    const toolCalls = message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // Sub-agent is done: return ONLY its conclusion to the parent.
      const conclusion = message.content ?? "(no recommendation)";
      emit({ type: "subagent_end", name: "London airport comparison", conclusion });
      return { recommendation: conclusion };
    }

    // Run the sub-agent's flight searches — same real tool, same cache, and
    // crucially recorded into the PARENT's ledger so the recommendation verifies.
    await Promise.all(
      toolCalls.map(async (call) => {
        if (call.type !== "function") {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "unsupported" }) });
          return;
        }
        const rawArgs = call.function.arguments;
        let parsed: any = {};
        try {
          parsed = JSON.parse(rawArgs);
        } catch {
          /* leave empty; the tool will error cleanly */
        }

        emit({
          type: "subagent_step",
          detail: `searching ${parsed.departure_id ?? "?"} → ${parsed.arrival_id ?? "?"}`,
        });

        const result = await searchFlightsLive(parsed);
        const output = JSON.stringify(result);

        // Shared ground truth: record into the parent ledger.
        try {
          ledger.record("search_flights", parsed, result);
        } catch {
          /* non-JSON-able result can't be ground truth anyway */
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }),
    );
  }

  emit({ type: "subagent_end", name: "London airport comparison", conclusion: "(hit turn limit)" });
  return { recommendation: "Could not complete the airport comparison within the step limit." };
}

// The schema the PARENT agent sees. To the parent, this is just another tool —
// it has no idea a whole second agent runs behind it. That opacity is the point:
// the parent delegates a sub-problem and gets an answer.
export const compareAirportsSchema = {
  type: "function" as const,
  function: {
    name: "compare_london_airports",
    description:
      "When the traveller flies from London (unspecified airport), use this to " +
      "compare all five London airports (Heathrow, Gatwick, Stansted, Luton, " +
      "City) and get a recommendation for the best one for this trip. Returns a " +
      "recommendation naming the best airport, airline, and price. Use this " +
      "INSTEAD of search_flights when the origin is 'London' generally.",
    parameters: {
      type: "object",
      properties: {
        arrival_id: { type: "string", description: "Destination airport IATA code, e.g. 'DUB'" },
        outbound_date: { type: "string", description: "Departure date, YYYY-MM-DD" },
        return_date: { type: "string", description: "Return date, YYYY-MM-DD" },
        currency: { type: "string", description: "Currency code, e.g. 'GBP'. Defaults to GBP." },
        priorities: {
          type: "string",
          description: "What the traveller values, e.g. 'cheapest' or 'fast to central London'",
        },
      },
      required: ["arrival_id", "outbound_date", "return_date"],
      additionalProperties: false,
    },
  },
};
