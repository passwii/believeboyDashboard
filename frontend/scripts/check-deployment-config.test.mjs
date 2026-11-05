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

test('VPS compose binds the app to loopback and loads runtime secrets from app.env', async () => {
  const compose = await read('frontend/deploy/docker-compose.yml')
  assert.match(compose, /127\.0\.0\.1:\$\{APP_PORT:-3200\}:3200/)
  assert.match(compose, /env_file:\s*\n\s*- \.\/app\.env/)
  assert.match(compose, /container_name: believeboy-dashboard/)
})

test('frontend deployment workflow is manual-only and publishes to GHCR', async () => {
  const workflow = await read('.github/workflows/deploy-frontend.yml')
  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /^on:\s*\n\s+push:/m)
  assert.match(workflow, /packages:\s*write/)
  assert.match(workflow, /ghcr\.io\/passwii\/believeboydashboard/)
  assert.match(workflow, /secrets\.NEXTAUTH_SECRET/)
})

test('deployment health endpoint is available outside the auth matcher', async () => {
  const route = await read('frontend/app/healthz/route.ts')
  const proxy = await read('frontend/proxy.ts')
  assert.match(route, /new Response\(['"]ok\\n['"]/)
  assert.match(proxy, /matcher:\s*\[['"]\/login['"],\s*['"]\/dashboard\/:path\*['"]\]/)
})
