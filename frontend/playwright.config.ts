import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html'], ['list']],
  use: {
    baseURL: 'http://localhost:3200',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 5'],
      },
    },
  ],
  webServer: process.env.CI
    ? {
        command: 'pnpm start',
        url: 'http://localhost:3200',
        reuseExistingServer: false,
        timeout: 120 * 1000,
        env: { NEXTAUTH_SECRET: 'blf611-e2e-fixture-secret-0123456789-abcdefghijklmnopqrstuvwxyz-42' },
      }
    : {
        command: 'pnpm dev',
        url: 'http://localhost:3200',
        reuseExistingServer: true,
        timeout: 120 * 1000,
        env: { NEXTAUTH_SECRET: 'blf611-e2e-fixture-secret-0123456789-abcdefghijklmnopqrstuvwxyz-42' },
      },
})
