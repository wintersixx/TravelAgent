/**
 * THE AGENT LOOP.
 *
 * This is the whole thing. Everything people call "an agent" is this:
 *
 *     while (true) {
 *       ask the model what to do next, given the conversation so far
 *       if it asked for tools -> run them, append results, continue
 *       if it just talked     -> we're done
 *     }
 *
 * Frameworks (LangGraph, CrewAI, the OpenAI Agents SDK) are wrappers around
 * this. Useful ones, but this is what's underneath. Read it once and the whole
 * category stops being mysterious.
 *
 * ── What changed when we added a UI ──────────────────────────────────────
 * The loop is identical to the CLI version. The only difference: instead of
 * calling console.log directly, it calls an `emit` function for every
 * interesting step. The CLI passes an emit that prints; the web server passes
 * an emit that pushes the event down an HTTP stream to the browser. Same loop,
 * two audiences. That separation — logic emits events, callers decide what to
 * do with them — is how you keep one agent usable from a terminal, a web app,
 * and a test harness without forking it three ways.
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { toolSchemas, runTool } from "./tools.js";
import {
  Ledger,
  verify,
  renderVerified,
  type StructuredItinerary,
} from "./verifier.js";

// A guard rail. Without it, a confused model that keeps calling tools forever
// will happily spend your money forever. Every production agent has one.
const MAX_TURNS = 10;

/**
 * Every meaningful thing the loop does becomes one of these events. This is the
 * agent's narration — the UI is built entirely out of this stream.
 */
export type AgentEvent =
  | { type: "turn_start"; turn: number; conversationLength: number }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; resultPreview: string }
  | { type: "verifying" }
  | { type: "verification"; verifiedCount: number; totalClaims: number; flagCount: number }
  | { type: "final"; text: string }
  | { type: "error"; message: string }
  | { type: "limit_reached"; maxTurns: number };

export type Emit = (event: AgentEvent) => void;

export interface AgentOptions {
  client: OpenAI;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Called for every step. Defaults to a no-op if you don't care. */
  emit?: Emit;
}

export async function runAgent({
  client,
  model,
  systemPrompt,
  userPrompt,
  emit = () => {},
}: AgentOptions): Promise<string> {
  /**
   * THE CONVERSATION.
   *
   * This array is the agent's entire mind. It has no other memory. Every turn we
   * send the whole thing back to the model, because the model is stateless — it
   * remembers nothing between calls. "Giving an agent memory" (Version 3 of the
   * exercise) just means putting more stuff in this array.
   *
   * It only ever grows. Watch it fill up as the loop runs.
   */
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // The ledger of ground truth. Every real tool result gets recorded here as it
  // happens, and the verifier checks the final itinerary against it. This is the
  // set of facts the model is allowed to build the answer from.
  const ledger = new Ledger();

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    emit({ type: "turn_start", turn, conversationLength: messages.length });

    // ── STEP 1: Ask the model what to do next ──────────────────────────────
    // We hand over the full conversation and the list of tools it may use.
    // Note what we do NOT do: we don't tell it which tool to call, or in what
    // order, or how many. That decision is the model's. That delegation of
    // control flow is exactly what makes this an "agent" and not a script.
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: toolSchemas as ChatCompletionTool[],
    });

    const message = response.choices[0].message;

    // ── STEP 2: Record what the model said ────────────────────────────────
    // Its reply goes into the conversation before we do anything else. If we
    // skipped this, the model would have no record of having asked for tools,
    // and the tool results we append next would refer to nothing.
    messages.push(message);

    if (message.content) {
      emit({ type: "thinking", text: message.content });
    }

    // ── STEP 3: Did it ask for tools? ─────────────────────────────────────
    // This is the branch the entire loop hinges on.
    const toolCalls = message.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // No tool calls means the model is done researching. But we DON'T just
      // return its prose anymore — that's exactly what let it slip Trinity
      // College and the Guinness Storehouse past us in the Dublin run.
      //
      // Instead we take one more step: ask it to render the itinerary as
      // STRUCTURED JSON, where every venue and price must be a tagged field.
      // Then we verify that structure against the ledger before anyone sees it.
      emit({ type: "verifying" });
      const finalText = await finaliseAndVerify(client, model, messages, ledger, emit);
      emit({ type: "final", text: finalText });
      return finalText;
    }

    // ── STEP 4: Run the tools it asked for ────────────────────────────────
    // The model can ask for several at once (e.g. hotels in Tokyo AND Kyoto).
    // These are independent, so we run them in parallel.
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        // Type narrowing: the SDK's union covers custom tools too, but we only
        // ever register function tools.
        if (call.type !== "function") {
          return { id: call.id, output: JSON.stringify({ error: "Unsupported tool type" }) };
        }

        const { name, arguments: rawArgs } = call.function;
        emit({ type: "tool_call", name, args: rawArgs });

        const output = runTool(name, rawArgs);

        // Record the real result into the ledger. This is ground truth — the
        // only facts the verifier will accept in the final itinerary.
        try {
          ledger.record(name, JSON.parse(rawArgs), JSON.parse(output));
        } catch {
          // If args/output aren't parseable JSON we simply don't ledger them;
          // an unparseable result can't be a source of verified facts anyway.
        }

        const preview = output.length > 200 ? output.slice(0, 200) + "…" : output;
        emit({ type: "tool_result", name, resultPreview: preview });

        return { id: call.id, output };
      }),
    );

    // ── STEP 5: Feed the results back in ──────────────────────────────────
    // Each result is appended as a "tool" message tagged with the id of the
    // call it answers. That id is how the model matches result to request. Get
    // this wrong and the API rejects the next request outright.
    //
    // And then... we loop. The model sees its own request plus the answer, and
    // decides what to do next. That's the feedback cycle. That's the agent.
    for (const { id, output } of results) {
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: output,
      });
    }
  }

  // We fell out of the loop without the model ever finishing.
  emit({ type: "limit_reached", maxTurns: MAX_TURNS });
  return `⚠️ Hit the ${MAX_TURNS}-turn limit without finishing.`;
}

/**
 * THE FINALISE + VERIFY STEP.
 *
 * Called once, when the model has finished researching. It does three things:
 *
 *   1. Asks the model to render its plan as STRUCTURED JSON (not prose), using
 *      response_format so the API guarantees valid JSON matching our shape.
 *      Every venue and price becomes a tagged field.
 *   2. Runs the verifier: does each venue/price actually appear in the ledger
 *      of real tool results?
 *   3. Renders the result as Markdown with any unverified items visibly flagged.
 *
 * This is where "don't hallucinate" stops being a request and becomes enforced.
 */
async function finaliseAndVerify(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  ledger: Ledger,
  emit: Emit,
): Promise<string> {
  // We ask for the structured itinerary. Note we reuse the same conversation —
  // the model already did all its research; now it just reformats what it found.
  const finalResponse = await client.chat.completions.create({
    model,
    messages: [
      ...messages,
      {
        role: "user",
        content:
          "Now output your final itinerary as JSON matching this exact shape:\n" +
          `{
  "summary": string,
  "days": [{ "day": string, "items": [{ "activity": string, "venue"?: string, "priceGBP"?: number }] }],
  "tradeoffs": string
}\n` +
          "CRITICAL RULE: the 'venue' and 'priceGBP' fields may ONLY contain " +
          "specific names and numbers that were returned by your tools. If a " +
          "tool did not return a venue or price, leave the field out and put a " +
          "general suggestion in 'activity' instead (e.g. 'find a traditional " +
          "pub in the centre'). Do not fill these fields from your own " +
          "knowledge — they will be automatically checked against the tool data.",
      },
    ],
    // This forces the API to return valid JSON. It does NOT force our shape or
    // enforce our rule — the model can still put a made-up venue in the field.
    // That's exactly why we still verify: structured output guarantees the
    // FORMAT, the verifier guarantees the FACTS.
    response_format: { type: "json_object" },
  });

  const raw = finalResponse.choices[0].message.content ?? "{}";

  let itinerary: StructuredItinerary;
  try {
    itinerary = JSON.parse(raw) as StructuredItinerary;
    // Minimal shape guard — a malformed structure shouldn't crash the run.
    if (!Array.isArray(itinerary.days)) itinerary.days = [];
    if (typeof itinerary.summary !== "string") itinerary.summary = "";
    if (typeof itinerary.tradeoffs !== "string") itinerary.tradeoffs = "";
  } catch {
    return "⚠️ The model did not return a valid itinerary structure.";
  }

  const result = verify(itinerary, ledger);
  emit({
    type: "verification",
    verifiedCount: result.verifiedCount,
    totalClaims: result.totalClaims,
    flagCount: result.flags.length,
  });

  return renderVerified(itinerary, result);
}
