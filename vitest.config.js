import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Test-only: exercised by the webhook-flush spec. Safe globally —
        // alarms only run when a test triggers them, and the expiry spec's
        // only visitor is already outside the flushable window.
        bindings: { WEBHOOK_URL: 'https://hooks.test/presence' },
      },
    }),
  ],
});
