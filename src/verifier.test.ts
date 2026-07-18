// Standalone check of the verifier — no model, no network. Proves the
// ground-truth logic works before we trust it in the loop.
import { Ledger, verify, renderVerified, type StructuredItinerary } from "./verifier.js";

const ledger = new Ledger();
// Simulate what real tool calls would have recorded.
ledger.record("search_activities", { city: "Tokyo" }, {
  results: [{ name: "Contact Tokyo", price: 25, note: "Underground techno" }],
});
ledger.record("search_flights", { from: "London", to: "Tokyo" }, {
  results: [{ airline: "Finnair", price: 610 }],
});

const itinerary: StructuredItinerary = {
  summary: "Test trip",
  days: [
    {
      day: "Day 1",
      items: [
        // Verifiable: venue + price both in the ledger.
        { activity: "Techno night", venue: "Contact Tokyo", priceGBP: 25 },
        // HALLUCINATED venue: never returned by any tool (the Dublin case).
        { activity: "Pub crawl", venue: "Temple Bar Dublin" },
        // HALLUCINATED price: number no tool returned.
        { activity: "Flight", venue: "Finnair", priceGBP: 999 },
        // Free-text only: no claim to verify, should pass silently.
        { activity: "Wander the backstreets" },
      ],
    },
  ],
  tradeoffs: "Test tradeoffs",
};

const result = verify(itinerary, ledger);

console.log("=== Verification result ===");
console.log(`verified: ${result.verifiedCount}/${result.totalClaims}`);
console.log(`flags: ${result.flags.length}`);
result.flags.forEach((f) => console.log(`  - [${f.kind}] ${f.detail}`));

// Assertions
const pass = (label: string, cond: boolean) =>
  console.log(`${cond ? "✅" : "❌ FAIL"} ${label}`);

console.log("\n=== Assertions ===");
// 3 venues (Contact Tokyo, Temple Bar, Finnair) + 2 prices (£25, £999) = 5 claims.
// The free-text "Wander the backstreets" item has no venue/price, so it isn't a claim.
pass("5 total claims (3 venues + 2 prices; free-text ignored)", result.totalClaims === 5);
// Contact Tokyo, its £25, and Finnair are all in the ledger = 3 verified.
pass("Contact Tokyo, £25, and Finnair verified", result.verifiedCount === 3);
pass("Temple Bar flagged as unverified venue", result.flags.some((f) => f.kind === "unverified_venue" && f.detail.includes("Temple Bar")));
pass("£999 flagged as unverified price", result.flags.some((f) => f.kind === "unverified_price" && f.detail.includes("999")));
pass("Finnair itself NOT flagged (it's real)", !result.flags.some((f) => f.detail.includes("Finnair")));

console.log("\n=== Rendered output ===");
console.log(renderVerified(itinerary, result));
