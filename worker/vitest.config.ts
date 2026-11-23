import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * 테스트는 Workers 런타임(workerd) 위에서 실행한다(§8.2).
 * 패키지가 0.23.0 에서 `@cloudflare/vitest-plugin` 으로 이름이 바뀌며
 * `defineWorkersConfig`(/config 서브패스)가 `cloudflareTest` 플러그인으로 대체되었다.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
