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
      // No tool calls means the model is finished working and is just talking
      // to us. That's our exit condition. The agent decided it was done — we
      // didn't decide for it.
      const final = message.content ?? "(no content)";
      emit({ type: "final", text: final });
      return final;
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
