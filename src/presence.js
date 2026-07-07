/**
 * Presence — one SQLite-backed Durable Object per site.
 *
 * Heartbeat pings upsert into a local `visitors` table; a ~10s alarm expires
 * visitors that stopped pinging and (optionally) flushes deltas to a webhook so
 * you can mirror presence into your own database. When the site empties, the
 * alarm lapses — an idle site costs nothing until the next ping re-arms it.
 *
 * Flush rules:
 *  - Only visitors seen within ACTIVE_WINDOW_MS are flushed: a flush implies
 *    "this visitor is here now", so stale visitors must never be sent.
 *  - A visitor flushes when dirty (new, or page/state changed) or when
 *    unchanged for REFRESH_MS — the keepalive lets the receiving side run its
 *    own liveness window without re-implementing ping semantics.
 *  - A failed flush keeps flags intact; the next alarm retries. Rows persist
 *    in SQLite, so nothing is lost to eviction or a webhook outage.
 */

import { DurableObject } from 'cloudflare:workers';

const FLUSH_MS = 10_000; // alarm cadence while the site has visitors
const REFRESH_MS = 30_000; // keepalive: re-flush unchanged visitors this often
const ACTIVE_WINDOW_MS = 45_000; // "still pinging" cutoff (snippet pings every 15s)
const EXPIRE_MS = 600_000; // drop visitors gone this long
const FLUSH_BATCH_LIMIT = 500;

export class Presence extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.site = undefined; // site name cache; persisted under storage key "site"
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS visitors (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          state TEXT,
          seen_ms INTEGER NOT NULL,
          dirty INTEGER NOT NULL DEFAULT 1,
          flushed_ms INTEGER NOT NULL DEFAULT 0
        )
      `);
    });
  }

  /**
   * @param {{site: string, id: string, url: string, state: ?string}} ping
   */
  async recordPing(ping) {
    if (!ping.id || !ping.url) {
      return;
    }

    // Persist the human site name for webhook payloads: an object doesn't
    // reliably know its own getByName() name across runtimes.
    if (ping.site && this.site !== ping.site) {
      await this.ctx.storage.put('site', ping.site);
      this.site = ping.site;
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO visitors (id, url, state, seen_ms, dirty, flushed_ms)
       VALUES (?, ?, ?, ?, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         url = excluded.url,
         state = excluded.state,
         seen_ms = excluded.seen_ms,
         dirty = CASE
           WHEN visitors.url != excluded.url
             OR COALESCE(visitors.state, '') != COALESCE(excluded.state, '')
           THEN 1 ELSE visitors.dirty END`,
      ping.id,
      ping.url,
      ping.state || null,
      Date.now(),
    );

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
    }
  }

  /**
   * Live snapshot: distinct visitors seen within the window, plus a per-path
   * breakdown. Every pinging visitor counts — an open, visible tab is a
   * concurrent reader; the snippet already pauses pings for idle/hidden tabs,
   * so idle handling belongs client-side, not here.
   */
  async liveStats(windowSeconds = 60) {
    const cutoff = Date.now() - windowSeconds * 1000;
    const count = this.ctx.storage.sql
      .exec('SELECT COUNT(*) AS c FROM visitors WHERE seen_ms >= ?', cutoff)
      .one().c;
    const paths = this.ctx.storage.sql
      .exec(
        'SELECT url, COUNT(*) AS visitors FROM visitors WHERE seen_ms >= ? GROUP BY url ORDER BY visitors DESC, url ASC LIMIT 25',
        cutoff,
      )
      .toArray();

    return { count, paths };
  }

  async alarm() {
    const now = Date.now();

    this.ctx.storage.sql.exec('DELETE FROM visitors WHERE seen_ms < ?', now - EXPIRE_MS);

    if (this.env.WEBHOOK_URL) {
      const due = this.ctx.storage.sql
        .exec(
          `SELECT id, url, state, seen_ms FROM visitors
           WHERE seen_ms >= ? AND (dirty = 1 OR flushed_ms <= ?)
           LIMIT ${FLUSH_BATCH_LIMIT}`,
          now - ACTIVE_WINDOW_MS,
          now - REFRESH_MS,
        )
        .toArray();

      if (due.length > 0) {
        await this.flushToWebhook(due, now);
      }
    }

    const remaining = this.ctx.storage.sql
      .exec('SELECT COUNT(*) AS c FROM visitors')
      .one().c;
    if (remaining > 0) {
      await this.ctx.storage.setAlarm(now + FLUSH_MS);
    }
    // Site is empty: let the alarm lapse — the next recordPing re-arms it.
  }

  async flushToWebhook(rows, now) {
    this.site ??= await this.ctx.storage.get('site');
    const body = JSON.stringify({
      site: this.site ?? '',
      flushed_at: new Date(now).toISOString(),
      visitors: rows.map((row) => ({
        id: row.id,
        url: row.url,
        state: row.state,
        seen_at: new Date(row.seen_ms).toISOString(),
      })),
    });

    const headers = { 'Content-Type': 'application/json' };
    if (this.env.WEBHOOK_SECRET) {
      headers['X-Headcount-Signature'] = await hmacHex(this.env.WEBHOOK_SECRET, body);
    }

    let response;
    try {
      response = await fetch(this.env.WEBHOOK_URL, { method: 'POST', headers, body });
    } catch (error) {
      console.error('headcount webhook errored', error instanceof Error ? error.message : error);
      return; // flags untouched — next alarm retries
    }

    if (!response.ok) {
      console.error('headcount webhook failed', response.status);
      try {
        await response.body?.cancel();
      } catch {}
      return;
    }
    try {
      await response.body?.cancel();
    } catch {}

    const placeholders = rows.map(() => '?').join(', ');
    this.ctx.storage.sql.exec(
      `UPDATE visitors SET dirty = 0, flushed_ms = ? WHERE id IN (${placeholders})`,
      now,
      ...rows.map((row) => row.id),
    );
  }
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
