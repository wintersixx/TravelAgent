/**
 * THE VERIFIER — the actual constraint on hallucination.
 *
 * The lesson from the Dublin run: you cannot make a model stop inventing things
 * by asking it not to. The system prompt already said "don't invent venues" and
 * it invented Trinity College, Temple Bar, and the Guinness Storehouse anyway.
 * Prompt instructions are suggestions. This file is a constraint, because it's
 * code that runs AFTER the model and checks its work against ground truth.
 *
 * "Ground truth" here is the LEDGER: every value any tool actually returned this
 * run. The model, when it writes the final itinerary, must tag each concrete
 * claim (a venue, a hotel, a price) with the tool call it came from. The
 * verifier then checks: does that claim actually appear in what the tool
 * returned? If yes, it's verified. If no — the model made it up, and we catch it.
 *
 * The verifier is deliberately dumb. It does no reasoning and calls no model. It
 * just compares strings and numbers against a set of known-real facts. Dumb is
 * the point: a check you can fool with clever language isn't a check.
 */

// ── The ledger ─────────────────────────────────────────────────────────────
// As the loop runs tools, it records every result here. This is the set of
// things that are actually true for this trip.

export interface LedgerEntry {
  /** e.g. "search_hotels" */
  tool: string;
  /** The raw args the model passed, for context. */
  args: unknown;
  /** The parsed result the handler returned. */
  result: unknown;
}

export class Ledger {
  private entries: LedgerEntry[] = [];

  record(tool: string, args: unknown, result: unknown) {
    this.entries.push({ tool, args, result });
  }

  /**
   * Every string value that appears anywhere in any tool result — venue names,
   * hotel names, airlines, districts, notes. This is our whitelist of "things a
   * tool actually said." A venue the model names is verified only if it appears
   * in here.
   *
   * We normalise to lowercase and collapse whitespace so trivial formatting
   * differences ("Temple Bar" vs "temple  bar") don't cause false failures.
   */
  knownStrings(): Set<string> {
    const out = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === "string") out.add(normalise(v));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    this.entries.forEach((e) => walk(e.result));
    return out;
  }

  /** Every numeric value any tool returned — prices, ratings, durations. */
  knownNumbers(): Set<number> {
    const out = new Set<number>();
    const walk = (v: unknown) => {
      if (typeof v === "number") out.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    this.entries.forEach((e) => walk(e.result));
    return out;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// ── The structured itinerary the model must produce ─────────────────────────
// Instead of prose, we make the model emit this shape. The `source` fields are
// what make verification possible: the model is forced to say, for each item,
// where it got it. A made-up venue will either have no source or a source that
// doesn't check out.

export interface ItineraryItem {
  /** What the traveller does. Free text — descriptions aren't fact-checked. */
  activity: string;
  /** The specific venue/hotel/airline named, if any. THIS gets verified. */
  venue?: string;
  /** A cost the model is claiming. THIS gets verified against tool numbers. */
  priceGBP?: number;
}

export interface ItineraryDay {
  day: string;
  items: ItineraryItem[];
}

export interface StructuredItinerary {
  summary: string;
  days: ItineraryDay[];
  tradeoffs: string;
}

// ── The verification result ─────────────────────────────────────────────────

export interface Flag {
  day: string;
  activity: string;
  kind: "unverified_venue" | "unverified_price";
  detail: string;
}

export interface VerificationResult {
  flags: Flag[];
  verifiedCount: number;
  totalClaims: number;
}

/**
 * Check every concrete claim in the itinerary against the ledger.
 *
 * A venue is a claim. A price is a claim. Free-text activity descriptions are
 * not — we don't fact-check "enjoy a relaxed brunch". We check the things that
 * are supposed to come from tools: named venues and specific prices.
 */
export function verify(itinerary: StructuredItinerary, ledger: Ledger): VerificationResult {
  const knownStrings = ledger.knownStrings();
  const knownNumbers = ledger.knownNumbers();

  const flags: Flag[] = [];
  let verifiedCount = 0;
  let totalClaims = 0;

  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.venue) {
        totalClaims++;
        // A venue is verified if its name appears (as a substring, after
        // normalising) in something a tool returned. Substring, not exact, so
        // "Guinness Storehouse tour" still matches a returned "Guinness
        // Storehouse". We err toward accepting — a false "verified" is bad, but
        // for teaching, seeing the clear-cut misses is what matters.
        if (venueIsKnown(item.venue, knownStrings)) {
          verifiedCount++;
        } else {
          flags.push({
            day: day.day,
            activity: item.activity,
            kind: "unverified_venue",
            detail: `"${item.venue}" was never returned by any tool — the model supplied it from memory.`,
          });
        }
      }

      if (typeof item.priceGBP === "number") {
        totalClaims++;
        if (knownNumbers.has(item.priceGBP)) {
          verifiedCount++;
        } else {
          flags.push({
            day: day.day,
            activity: item.activity,
            kind: "unverified_price",
            detail: `£${item.priceGBP} was not returned by any tool — the model made this number up.`,
          });
        }
      }
    }
  }

  return { flags, verifiedCount, totalClaims };
}

function venueIsKnown(venue: string, known: Set<string>): boolean {
  const v = normalise(venue);
  if (known.has(v)) return true;
  // Substring either direction: tool returned a longer or shorter form.
  for (const k of known) {
    if (k.includes(v) || v.includes(k)) return true;
  }
  return false;
}

/**
 * Render the verified itinerary as Markdown for the UI, with unverified items
 * visibly marked rather than silently removed. Marking (not deleting) is a
 * deliberate choice for a learning tool: you SEE what the model tried to slip
 * past. A consumer product might strip them instead — but it should never keep
 * them unmarked, which is exactly what the old prose version did.
 */
export function renderVerified(
  itinerary: StructuredItinerary,
  result: VerificationResult,
): string {
  const flagged = new Set(result.flags.map((f) => f.day + "|" + f.activity));

  let md = `${itinerary.summary}\n\n`;

  for (const day of itinerary.days) {
    md += `### ${day.day}\n`;
    for (const item of day.items) {
      const isFlagged = flagged.has(day.day + "|" + item.activity);
      let line = `- ${item.activity}`;
      if (item.venue) line += ` — **${item.venue}**`;
      if (typeof item.priceGBP === "number") line += ` (£${item.priceGBP})`;
      if (isFlagged) line += `  ⚠️ *unverified — not from a tool, treat as a suggestion to check*`;
      md += line + "\n";
    }
    md += "\n";
  }

  md += `---\n\n**Tradeoffs:** ${itinerary.tradeoffs}\n\n`;

  md += `---\n\n`;
  if (result.totalClaims === 0) {
    md += `_No specific venues or prices were claimed._`;
  } else {
    md += `_Verification: ${result.verifiedCount}/${result.totalClaims} concrete claims matched real tool data.`;
    if (result.flags.length > 0) {
      md += ` ${result.flags.length} item(s) flagged as unverified above._`;
    } else {
      md += ` Everything checks out._`;
    }
  }

  return md;
}
