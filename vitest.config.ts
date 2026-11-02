import { defineConfig } from "vitest/config";

export default defineConfig({
  // 缓存放在项目内，避免宿主安全策略拦截系统临时目录写入导致测试偶发加载失败
  cacheDir: ".vitest-cache",
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    reporters: ["default"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
