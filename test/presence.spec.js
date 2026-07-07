import { env, SELF, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

async function ping(site, id, url, state) {
  return SELF.fetch('https://hc.test/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site, id, url, state }),
  });
}

async function live(site, windowSeconds = 60) {
  const res = await SELF.fetch(`https://hc.test/live?site=${site}&window=${windowSeconds}`);
  return res.json();
}

describe('ping → live', () => {
  it('counts distinct visitors, not pings', async () => {
    expect((await ping('blog', 'v1', '/a')).status).toBe(202);
    await ping('blog', 'v1', '/a');
    await ping('blog', 'v2', '/b');

    const stats = await live('blog');
    expect(stats.count).toBe(2);
    expect(stats.paths).toEqual([
      { url: '/a', visitors: 1 },
      { url: '/b', visitors: 1 },
    ]);
  });

  it('isolates sites from each other', async () => {
    await ping('site-a', 'v1', '/');
    await ping('site-b', 'v1', '/');
    await ping('site-b', 'v2', '/');

    expect((await live('site-a')).count).toBe(1);
    expect((await live('site-b')).count).toBe(2);
  });

  it('records via the GIF fallback beacon', async () => {
    const res = await SELF.fetch('https://hc.test/ping.gif?site=gif-site&id=v9&url=%2Fpage');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/gif');
    await res.body?.cancel();

    expect((await live('gif-site')).count).toBe(1);
  });

  it('rejects pings missing required fields', async () => {
    const res = await SELF.fetch('https://hc.test/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: 'blog' }),
    });
    expect(res.status).toBe(422);
    await res.body?.cancel();
  });
});

describe('expiry', () => {
  it('drops visitors after the expiry window via the alarm', async () => {
    await ping('expiring', 'old-visitor', '/a');
    const stub = env.PRESENCE.getByName('expiring');

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE visitors SET seen_ms = ? WHERE id = ?',
        Date.now() - 700_000, // past EXPIRE_MS (600s)
        'old-visitor',
      );
    });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    expect((await live('expiring', 3600)).count).toBe(0);
  });
});

describe('webhook flush', () => {
  it('posts active visitors and clears dirty flags on success', async () => {
    await ping('hooked', 'v1', '/a', 'R');
    const stub = env.PRESENCE.getByName('hooked');

    // Stub fetch inside the DO's own context and drive the alarm, which flushes
    // because WEBHOOK_URL is injected via vitest.config.js miniflare bindings.
    const received = await runInDurableObject(stub, async (instance) => {
      let captured = null;
      const original = globalThis.fetch;
      globalThis.fetch = async (url, opts) => {
        captured = { url: String(url), body: JSON.parse(opts.body), headers: opts.headers };
        return new Response('{}', { status: 200 });
      };
      try {
        await instance.alarm();
      } finally {
        globalThis.fetch = original;
      }

      return captured;
    });

    expect(received.url).toBe('https://hooks.test/presence');
    expect(received.body.site).toBe('hooked');
    expect(received.body.visitors).toHaveLength(1);
    expect(received.body.visitors[0]).toMatchObject({ id: 'v1', url: '/a', state: 'R' });

    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql.exec('SELECT dirty FROM visitors WHERE id = ?', 'v1').one();
      expect(row.dirty).toBe(0);
    });
  });
});
