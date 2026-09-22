import { defineConfig, devices } from '@playwright/test'

// BLF-1072 一次性观测配置：复用已在跑的 dev server（3310），不再由 Playwright 起 webServer。
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${process.env.PLAYWRIGHT_PORT || '3310'}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
