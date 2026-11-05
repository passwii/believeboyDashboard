import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..')

async function read(relativePath) {
  return readFile(path.join(REPO_ROOT, relativePath), 'utf8')
}

test('Next.js emits a standalone server for the container image', async () => {
  const nextConfig = await read('frontend/next.config.js')
  assert.match(nextConfig, /output:\s*['"]standalone['"]/)
})

test('Docker build keeps the runtime secret out of image layers', async () => {
  const dockerfile = await read('frontend/Dockerfile')
  assert.match(dockerfile, /--mount=type=secret,id=nextauth_secret/)
  assert.match(dockerfile, /id=believeboy-pnpm-store/)
  assert.match(dockerfile, /\.next\/standalone/)
  assert.doesNotMatch(dockerfile, /ARG\s+NEXTAUTH_SECRET/)
  assert.doesNotMatch(dockerfile, /ENV\s+NEXTAUTH_SECRET/)
})

test('VPS compose runs the application stack on host networking without absorbing shared infrastructure', async () => {
  const compose = await read('deploy/docker-compose.yml')
  for (const service of ['migrate', 'api', 'celery', 'celery-scheduled', 'beat', 'web']) {
    assert.match(compose, new RegExp(`^  ${service}:`, 'm'))
  }
  assert.doesNotMatch(compose, /^  postgres:/m)
  assert.doesNotMatch(compose, /^  redis:/m)
  assert.equal((compose.match(/network_mode: host/g) ?? []).length, 6)
  assert.match(compose, /API_IMAGE:\?API_IMAGE must be set/)
  assert.match(compose, /WEB_IMAGE:\?WEB_IMAGE must be set/)
  assert.match(compose, /believeboy-dashboard-api/)
  assert.match(compose, /believeboy-dashboard-web/)
})

test('API image contains the Playwright runtime without running as root', async () => {
  const dockerfile = await read('backend/Dockerfile')
  assert.match(dockerfile, /playwright install --with-deps --only-shell chromium/)
  assert.match(dockerfile, /PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/)
  assert.match(dockerfile, /USER app/)
  assert.match(dockerfile, /id=believeboy-pip-cache/)
})

test('dashboard deployment workflow is manual-only and publishes both images', async () => {
  const workflow = await read('.github/workflows/deploy-dashboard.yml')
  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /^on:\s*\n\s+push:/m)
  assert.match(workflow, /packages:\s*write/)
  assert.match(workflow, /secrets\.GHCR_TOKEN/)
  assert.match(workflow, /ghcr\.io\/passwii\/believeboydashboard-api/)
  assert.match(workflow, /ghcr\.io\/passwii\/believeboydashboard-web/)
  assert.match(workflow, /secrets\.NEXTAUTH_SECRET/)
  assert.match(workflow, /steps\.api\.outputs\.digest/)
  assert.match(workflow, /steps\.web\.outputs\.digest/)
})

test('remote deploy keeps the SSH script stream out of Compose run', async () => {
  const script = await read('deploy/deploy-remote.sh')
  assert.match(script, /docker compose run --rm -T migrate/)
  assert.doesNotMatch(script, /docker compose run --rm migrate/)
})

test('server-side backend calls prefer loopback while browser metadata stays public', async () => {
  const envExample = await read('deploy/web.env.example')
  const backendApi = await read('frontend/lib/server/backend-api.ts')
  assert.match(envExample, /^BACKEND_INTERNAL_URL=http:\/\/127\.0\.0\.1:8100$/m)
  assert.match(envExample, /^BACKEND_PUBLIC_API_BASE_URL=https:\/\/dash-api\.believeboy\.com$/m)
  assert.match(backendApi, /process\.env\.BACKEND_INTERNAL_URL/)
  assert.match(backendApi, /process\.env\.BACKEND_PUBLIC_API_BASE_URL/)
})

test('deployment health endpoint is available outside the auth matcher', async () => {
  const route = await read('frontend/app/healthz/route.ts')
  const proxy = await read('frontend/proxy.ts')
  assert.match(route, /new Response\(['"]ok\\n['"]/)
  assert.match(proxy, /matcher:\s*\[['"]\/login['"],\s*['"]\/dashboard\/:path\*['"]\]/)
})
