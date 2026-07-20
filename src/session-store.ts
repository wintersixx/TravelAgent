/**
 * THE SESSION STORE — where conversational memory actually lives.
 *
 * The single reason the app was "stateless" before: every request built a fresh
 * conversation and threw it away when the response finished. This store is the
 * fix. It keeps each conversation alive, keyed by a session id the browser
 * sends, so a follow-up ("make it an evening flight") continues the SAME
 * conversation instead of starting cold.
 *
 * It's a plain in-memory Map. That's deliberate for learning — it makes the
 * mechanism obvious and has zero setup. Its limits are worth naming, because
 * they're exactly what a real deployment has to solve:
 *   - Resets on server restart (memory isn't durable).
 *   - Doesn't scale past one server (a second instance has its own Map).
 *   - Grows forever without the eviction below.
 * In production this becomes Redis or a database row. The shape stays the same.
 */

import type { Session } from "./agent.js";
import { newSession } from "./agent.js";

interface StoredSession {
  session: Session;
  lastUsed: number;
}

const sessions = new Map<string, StoredSession>();

// Evict conversations untouched for this long, so memory doesn't grow forever.
const TTL_MS = 1000 * 60 * 60; // 1 hour

/**
 * Get the session for this id, creating a fresh one (with the given system
 * prompt) if it's new or has expired. Returns whether it was newly created, so
 * the caller can tell a first message from a follow-up.
 */
export function getOrCreateSession(
  id: string,
  systemPrompt: string,
): { session: Session; isNew: boolean } {
  evictStale();

  const existing = sessions.get(id);
  if (existing) {
    existing.lastUsed = Date.now();
    return { session: existing.session, isNew: false };
  }

  const session = newSession(systemPrompt);
  sessions.set(id, { session, lastUsed: Date.now() });
  return { session, isNew: true };
}

/** How many turns (user messages) a session has seen — handy for logging/UI. */
export function turnCount(session: Session): number {
  return session.messages.filter((m) => m.role === "user").length;
}

function evictStale() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, s] of sessions) {
    if (s.lastUsed < cutoff) sessions.delete(id);
  }
}
