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

// ---------------------------------------------------------------------------
// 1. SCHEMAS — what the model sees
// ---------------------------------------------------------------------------

export const toolSchemas = [
  {
    type: "function" as const,
    function: {
      name: "search_flights",
      description:
        "Search for return flights between two cities on given dates. " +
        "Returns a list of options with airline, price in GBP, and duration.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Departure city, e.g. 'London'" },
          to: { type: "string", description: "Arrival city, e.g. 'Tokyo'" },
          departDate: { type: "string", description: "Departure date, YYYY-MM-DD" },
          returnDate: { type: "string", description: "Return date, YYYY-MM-DD" },
        },
        required: ["from", "to", "departDate", "returnDate"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_hotels",
      description:
        "Search for hotels in a city for a date range. Returns options with " +
        "name, district, price per night in GBP, and a rating out of 10.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City to search, e.g. 'Tokyo'" },
          checkIn: { type: "string", description: "Check-in date, YYYY-MM-DD" },
          checkOut: { type: "string", description: "Check-out date, YYYY-MM-DD" },
          maxPricePerNight: {
            type: "number",
            description: "Optional cap on nightly price in GBP",
          },
        },
        required: ["city", "checkIn", "checkOut"],
        additionalProperties: false,
      },
    },
  },
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

type Handler = (args: any) => unknown;

const searchFlights: Handler = ({ from, to, departDate, returnDate }) => ({
  query: { from, to, departDate, returnDate },
  results: [
    { airline: "ANA", price: 812, durationHours: 14.5, stops: 0 },
    { airline: "JAL", price: 780, durationHours: 14.75, stops: 0 },
    { airline: "Finnair", price: 610, durationHours: 17.5, stops: 1 },
    { airline: "Emirates", price: 545, durationHours: 22, stops: 1 },
    { airline: "China Eastern", price: 430, durationHours: 26, stops: 2 },
  ],
});

const searchHotels: Handler = ({ city, checkIn, checkOut, maxPricePerNight }) => {
  const byCity: Record<string, any[]> = {
    tokyo: [
      { name: "Park Hotel Tokyo", district: "Shiodome", pricePerNight: 180, rating: 8.7 },
      { name: "Hotel Gracery", district: "Shinjuku", pricePerNight: 130, rating: 8.2 },
      { name: "Wired Hotel", district: "Asakusa", pricePerNight: 95, rating: 8.5 },
      { name: "Nine Hours", district: "Shinjuku", pricePerNight: 45, rating: 7.9 },
    ],
    kyoto: [
      { name: "Hotel Kanra", district: "Karasuma", pricePerNight: 210, rating: 9.1 },
      { name: "Nine Hours Kyoto", district: "Teramachi", pricePerNight: 50, rating: 8.0 },
      { name: "Piece Hostel Sanjo", district: "Sanjo", pricePerNight: 65, rating: 8.6 },
    ],
    osaka: [
      { name: "Hotel Hanshin", district: "Umeda", pricePerNight: 110, rating: 8.3 },
      { name: "The Blend Inn", district: "Fukushima", pricePerNight: 85, rating: 8.8 },
    ],
  };

  const all = byCity[String(city).toLowerCase()] ?? [];
  const results =
    typeof maxPricePerNight === "number"
      ? all.filter((h) => h.pricePerNight <= maxPricePerNight)
      : all;

  return { query: { city, checkIn, checkOut, maxPricePerNight }, results };
};

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
  search_flights: searchFlights,
  search_hotels: searchHotels,
  search_activities: searchActivities,
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
export function runTool(name: string, rawArgs: string): string {
  try {
    const handler = toolHandlers[name];
    if (!handler) {
      return JSON.stringify({ error: `No such tool: ${name}` });
    }
    const args = JSON.parse(rawArgs);
    return JSON.stringify(handler(args));
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
