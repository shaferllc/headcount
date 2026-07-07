/**
 * headcount — real-time concurrent-visitor counting on Cloudflare Workers.
 *
 * Endpoints:
 *   POST /ping        {site, id, url, state?}   heartbeat (also accepts
 *                                               text/plain JSON from sendBeacon)
 *   GET  /ping.gif    ?site&id&url&state        1×1 GIF fallback for blocked POSTs
 *   GET  /live        ?site&window=60           {count, paths}
 *
 * Static assets (snippet, widget, demo) are served from ./public by the
 * Workers assets pipeline; anything that isn't an asset lands here.
 */

import { Presence } from './presence.js';

export { Presence };

const BEACON_GIF = '\x47\x49\x46\x38\x39\x61\x01\x00\x01\x00\x80\x00\x00\xFF\xFF\xFF\x00\x00\x00\x21\xF9\x04\x00\x00\x00\x00\x00\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3B';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    switch (url.pathname) {
      case '/ping':
        return handlePing(request, url, env, ctx, cors);
      case '/ping.gif':
        return handlePingGif(request, url, env, ctx, cors);
      case '/live':
        return handleLive(request, url, env, cors);
      case '/ws':
        return handleWs(request, url, env, cors);
      default:
        return json({ error: 'Not found' }, 404, cors);
    }
  },
};

async function handlePing(request, url, env, ctx, cors) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, cors);
  }

  let body;
  try {
    // sendBeacon posts text/plain; request.json() refuses nothing by type,
    // but be explicit that we parse whatever arrived as JSON.
    body = JSON.parse(await request.text());
  } catch {
    return json({ error: 'Invalid JSON body' }, 422, cors);
  }

  const ping = normalizePing(body);
  if (!ping) {
    return json({ error: 'site, id and url are required' }, 422, cors);
  }
  if (!siteAllowed(env, ping.site)) {
    return json({ error: 'Unknown site' }, 404, cors);
  }

  ctx.waitUntil(env.PRESENCE.getByName(ping.site).recordPing(ping));

  return json({ ok: true }, 202, cors);
}

async function handlePingGif(request, url, env, ctx, cors) {
  const ping = normalizePing(Object.fromEntries(url.searchParams.entries()));
  if (ping && siteAllowed(env, ping.site)) {
    ctx.waitUntil(env.PRESENCE.getByName(ping.site).recordPing(ping));
  }

  return new Response(BEACON_GIF, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

async function handleLive(request, url, env, cors) {
  const site = (url.searchParams.get('site') || '').trim();
  if (site === '') {
    return json({ error: 'site is required' }, 422, cors);
  }
  if (!siteAllowed(env, site)) {
    return json({ error: 'Unknown site' }, 404, cors);
  }

  const windowSeconds = clamp(parseInt(url.searchParams.get('window'), 10) || 60, 15, 3600);
  const stats = await env.PRESENCE.getByName(site).liveStats(windowSeconds);

  if (String(env.EXPOSE_PATHS).toLowerCase() === 'false') {
    delete stats.paths;
  }

  return json({ site, window: windowSeconds, ...stats }, 200, {
    ...cors,
    // Give CDNs/browsers a tiny cache so widget polling from many viewers
    // collapses; the count only moves on a 10s-ish cadence anyway.
    'Cache-Control': 'public, max-age=3',
  });
}

async function handleWs(request, url, env, cors) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'Expected WebSocket upgrade' }, 426, cors);
  }
  const site = (url.searchParams.get('site') || '').trim();
  if (site === '') {
    return json({ error: 'site is required' }, 422, cors);
  }
  if (!siteAllowed(env, site)) {
    return json({ error: 'Unknown site' }, 404, cors);
  }

  // The DO owns the socket; count pushes come from its ping/alarm paths.
  return env.PRESENCE.getByName(site).fetch(request);
}

function normalizePing(src) {
  const site = typeof src?.site === 'string' ? src.site.trim() : '';
  const id = typeof src?.id === 'string' ? src.id.trim() : '';
  const rawUrl = typeof src?.url === 'string' ? src.url.trim() : '';
  if (site === '' || id === '' || rawUrl === '' || site.length > 100 || id.length > 100 || rawUrl.length > 2000) {
    return null;
  }
  const state = typeof src?.state === 'string' && src.state !== '' ? src.state.slice(0, 16) : null;

  return { site, id, url: rawUrl, state };
}

function siteAllowed(env, site) {
  const allow = (env.SITES || '').trim();
  if (allow === '') {
    return true;
  }

  return allow.split(',').map((s) => s.trim()).includes(site);
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
