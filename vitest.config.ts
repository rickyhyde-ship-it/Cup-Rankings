import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
export default defineConfig({
  plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'},miniflare:{compatibilityDate:'2026-08-22',bindings:{ADMIN_TOKEN:'test-key',GITHUB_TOKEN:'test-github-token',SYNC_GITHUB:'false'}}})],
  test:{include:['tests/**/*.test.ts'],fileParallelism:false}
});
