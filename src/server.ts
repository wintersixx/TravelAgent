/**
 * THE BACKEND.
 *
 * This is the piece that would live on Google Cloud (Cloud Run, App Engine, a
 * plain VM — doesn't matter). Its entire reason to exist is that it holds the
 * OpenAI API key. The browser must never see that key: anyone can open dev
 * tools, read it, and spend your money. So the browser talks to THIS, and this
 * talks to OpenAI. That's the whole security argument for having a backend at
 * all, and it's the same argument at any scale.
 *
 * It exposes one endpoint, GET /api/plan?prompt=..., and streams the agent's
 * progress back using Server-Sent Events (SSE) — a dead-simple "server keeps
 * the HTTP connection open and writes lines as things happen" protocol that the
 * browser consumes with the built-in EventSource API. We use SSE rather than
 * WebSockets because the data only flows one way (server → browser) and SSE is
 * far less code for that case.
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { runAgent, type AgentEvent } from "./agent.js";
import { buildSystemPrompt } from "./prompt.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("❌ No OPENAI_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const client = new OpenAI({ apiKey });
const app = express();

// CORS: in production your frontend (Vercel/CF Pages) and backend (Google
// Cloud) live on different domains, and browsers block cross-origin requests
// unless the server opts in. This header is that opt-in. For learning we allow
// any origin; in production you'd pin it to your actual frontend domain.
app.use(cors());

// Serve the static frontend from /public, so you can open one URL and get the
// page. In a real split deploy the frontend is hosted separately; bundling it
// here just means one thing to run locally.
app.use(express.static("public"));

app.get("/api/plan", async (req, res) => {
  const prompt = String(req.query.prompt ?? "").trim();
  if (!prompt) {
    res.status(400).json({ error: "Missing ?prompt=" });
    return;
  }

  // ── Open an SSE stream ──────────────────────────────────────────────────
  // These three headers turn a normal response into a stream the browser keeps
  // open. After this, every res.write() is a message the browser receives live.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // SSE wire format is literally: `data: <json>\n\n`. That's the whole protocol.
  const send = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // If the user closes the tab mid-plan, stop caring. (A more complete version
  // would also abort the OpenAI request to stop burning tokens; noted, not done.)
  let clientGone = false;
  req.on("close", () => {
    clientGone = true;
  });

  try {
    await runAgent({
      client,
      model: "gpt-5.4-mini-2026-03-17",
      systemPrompt: buildSystemPrompt(),
      userPrompt: prompt,
      // Every event the loop emits gets pushed straight down the wire. The UI
      // is quite literally a rendering of this stream.
      emit: (event) => {
        if (!clientGone) send(event);
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!clientGone) send({ type: "error", message });
  } finally {
    // A sentinel so the browser knows the stream is finished and can close it.
    if (!clientGone) res.write("event: done\ndata: {}\n\n");
    res.end();
  }
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`🌐 Trip Planner running at http://localhost:${PORT}`);
});
