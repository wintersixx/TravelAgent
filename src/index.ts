/**
 * Entry point. This file is just wiring — the interesting code is in agent.ts.
 */

import "dotenv/config";
import OpenAI from "openai";
import { runAgent } from "./agent.js";

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

/**
 * THE SYSTEM PROMPT.
 *
 * This is where you shape behaviour. Not with code — with words. It is the
 * highest-leverage file in most agent codebases, and it's the part that feels
 * least like engineering at first.
 *
 * Notice what it's doing: giving the model a job, telling it what tools exist
 * and roughly when to reach for them, and telling it when to stop. That last
 * part matters — "stop calling tools and write the answer" is a real
 * instruction the model needs, not something it infers reliably.
 */
const systemPrompt = `You are a trip planning agent.

You have tools to search flights, hotels, and activities. Use them to gather
real options before making any recommendation. Do not invent prices or venues —
if you haven't looked it up with a tool, don't claim it.

Work like this:
1. Search for the things you need. You can search several at once.
2. Once you have enough information, stop searching and write the plan.

Your final answer should be a day-by-day itinerary with a cost breakdown that
adds up, and a short section explaining the tradeoffs you made — what you chose,
what you gave up, and why. Be opinionated. The traveller wants a real
recommendation, not a list of possibilities.`;

const userPrompt = `Plan me a 7-day Japan trip, 10th to 17th October, flying from London.

Budget: £2500 total.

I care about:
- Amazing food
- Nightlife (underground techno especially)
- Photography

I want to avoid tourist traps and I don't like early mornings.

I want Tokyo nightlife but I'd also like to see Kyoto if it's worth it.`;

console.log("🤖 Trip Planner Agent");
console.log("═".repeat(70));
console.log(userPrompt);

const answer = await runAgent({
  client,
  // gpt-4.1 is a good default here: strong tool calling, cheap enough to run
  // this loop repeatedly while you're learning.
  model: "gpt-4.1",
  systemPrompt,
  userPrompt,
});

console.log(`\n${"═".repeat(70)}`);
console.log("🏁 FINAL ANSWER");
console.log("═".repeat(70));
console.log(answer);
