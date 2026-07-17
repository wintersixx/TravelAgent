/**
 * CLI entry point. This file is just wiring — the interesting code is in
 * agent.ts. It shares the loop and the system prompt with the web server
 * (server.ts); the only difference is that here `emit` prints to the terminal.
 */

import "dotenv/config";
import OpenAI from "openai";
import { runAgent, type AgentEvent } from "./agent.js";
import { buildSystemPrompt } from "./prompt.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error(
    "❌ No OPENAI_API_KEY found.\n" +
      "   Copy .env.example to .env and paste your key in:\n" +
      "     cp .env.example .env",
  );
  process.exit(1);
}

const client = new OpenAI({ apiKey });

const userPrompt = `Plan me a 7-day Japan trip, 10th to 17th October, flying from London.

Budget: £2500 total.

I care about:
- Amazing food
- Nightlife (underground techno especially)
- Photography

I want to avoid tourist traps and I don't like early mornings.

I want Tokyo nightlife but I'd also like to see Kyoto if it's worth it.`;

// The CLI's job is to turn agent events into terminal output.
const printEvent = (e: AgentEvent) => {
  switch (e.type) {
    case "turn_start":
      console.log(`\n${"─".repeat(70)}`);
      console.log(`TURN ${e.turn}  (conversation is ${e.conversationLength} messages long)`);
      console.log("─".repeat(70));
      break;
    case "thinking":
      console.log(`\n💭 Model says:\n${e.text}\n`);
      break;
    case "tool_call":
      console.log(`🔧 ${e.name}(${e.args})`);
      break;
    case "tool_result":
      console.log(`   ↩ ${e.resultPreview}`);
      break;
    case "final":
      console.log(`\n${"═".repeat(70)}`);
      console.log("🏁 FINAL ANSWER");
      console.log("═".repeat(70));
      console.log(e.text);
      break;
    case "limit_reached":
      console.log(`⚠️ Hit the ${e.maxTurns}-turn limit.`);
      break;
    case "error":
      console.error(`❌ ${e.message}`);
      break;
  }
};

console.log("🤖 Trip Planner Agent");
console.log("═".repeat(70));
console.log(userPrompt);

await runAgent({
  client,
  model: "gpt-4.1",
  systemPrompt: buildSystemPrompt(),
  userPrompt,
  emit: printEvent,
});
