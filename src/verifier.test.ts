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
ledger.record("search_hotels", { city: "Tokyo" }, {
  results: [{ name: "Wired Hotel", pricePerNight: 95, rating: 8.5 }],
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
        // Real flight: airline + price both in the ledger.
        { activity: "Fly out", flight: { airline: "Finnair", priceGBP: 610 } },
        // Real airline, INVENTED price — must be flagged (both must be real).
        { activity: "Fly home", flight: { airline: "Finnair", priceGBP: 50 } },
        // Real hotel + real price → verified.
        { activity: "Check in", hotel: { name: "Wired Hotel", pricePerNightGBP: 95 } },
        // HALLUCINATED hotel name → flagged.
        { activity: "Alt stay", hotel: { name: "The Ritz Tokyo", pricePerNightGBP: 95 } },
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
// 3 venues + 2 prices + 2 flights + 2 hotels = 9 claims.
pass("9 total claims (3 venues + 2 prices + 2 flights + 2 hotels)", result.totalClaims === 9);
// Verified: Contact Tokyo, £25, Finnair(venue), Finnair/£610 flight, Wired Hotel = 5.
pass("5 claims verified", result.verifiedCount === 5);
pass("Temple Bar flagged as unverified venue", result.flags.some((f) => f.kind === "unverified_venue" && f.detail.includes("Temple Bar")));
pass("£999 flagged as unverified price", result.flags.some((f) => f.kind === "unverified_price" && f.detail.includes("999")));
pass("Finnair/£610 flight NOT flagged (both real)", !result.flags.some((f) => f.kind === "unverified_flight" && f.detail.includes("610")));
pass("Finnair/£50 flight flagged (price invented)", result.flags.some((f) => f.kind === "unverified_flight" && f.detail.includes("50")));
pass("Wired Hotel NOT flagged (real name + price)", !result.flags.some((f) => f.kind === "unverified_hotel" && f.detail.includes("Wired")));
pass("The Ritz Tokyo flagged (hallucinated hotel)", result.flags.some((f) => f.kind === "unverified_hotel" && f.detail.includes("Ritz")));

console.log("\n=== Rendered output ===");
console.log(renderVerified(itinerary, result));
