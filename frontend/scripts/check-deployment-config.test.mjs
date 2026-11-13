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

test('VPS compose runs the Go application stack on host networking without absorbing shared infrastructure', async () => {
  const compose = await read('deploy/docker-compose.yml')
  for (const service of ['migrate', 'go-api', 'go-worker', 'go-scheduler', 'web']) {
    assert.match(compose, new RegExp(`^  ${service}:`, 'm'))
  }
  assert.doesNotMatch(compose, /^  (api|celery|celery-scheduled|beat):/m)
  assert.doesNotMatch(compose, /^  postgres:/m)
  assert.doesNotMatch(compose, /^  redis:/m)
  assert.equal((compose.match(/network_mode: host/g) ?? []).length, 5)
  assert.match(compose, /GO_API_IMAGE:\?GO_API_IMAGE must be set/)
  assert.match(compose, /WEB_IMAGE:\?WEB_IMAGE must be set/)
  assert.doesNotMatch(compose, /API_IMAGE:\?API_IMAGE must be set/)
  // Migration cutover (2026-11-10): migrate runs the Go image's embedded Goose runner.
  assert.match(compose, /entrypoint: \["\/usr\/local\/bin\/go-migrate"\]/)
  assert.match(compose, /command: \["up"\]/)
  assert.doesNotMatch(compose, /alembic upgrade/)
  assert.match(compose, /believeboy-dashboard-go-api/)
  assert.match(compose, /believeboy-dashboard-go-worker/)
  assert.match(compose, /believeboy-dashboard-go-scheduler/)
  assert.match(compose, /believeboy-dashboard-web/)
  assert.doesNotMatch(compose, /believeboy-dashboard-api/)
  assert.match(compose, /\.\/backend\.env/)
  assert.match(compose, /\.\/go\.env/)
  assert.match(compose, /\.\/web\.env/)
  // 2026-11-10：容器健康检查改为 DB 感知的 readiness；live 探针不查库，
  // 曾导致 Go 网关 DB 全挂而容器仍显示 healthy。
  assert.match(compose, /8200\/api\/v1\/health\/ready/)
  assert.match(compose, /3200\/healthz/)
})

test('Go API and Web images contain the required production runtimes', async () => {
  const goDockerfile = await read('backend-go/Dockerfile')
  const webDockerfile = await read('frontend/Dockerfile')
  assert.match(goDockerfile, /apk add --no-cache ca-certificates tzdata chromium font-noto-cjk/)
  assert.match(goDockerfile, /CGO_ENABLED=0/)
  assert.match(goDockerfile, /USER 10001:10001/)
  assert.match(goDockerfile, /EXPOSE 8200/)
  assert.match(goDockerfile, /id=believeboy-go-mod-cache/)
  // 2026-11-10：alpine runtime 必须带 tzdata，否则 pgx AfterConnect 的
  // time.LoadLocation 失败，所有 DB 路由 500（/health/live 仍绿）。
  assert.match(goDockerfile, /apk add --no-cache ca-certificates tzdata/)
  assert.match(webDockerfile, /--mount=type=secret,id=nextauth_secret/)
  assert.match(webDockerfile, /id=believeboy-pnpm-store/)
  assert.match(webDockerfile, /\.next\/standalone/)
  assert.match(webDockerfile, /USER nextjs/)
  assert.match(webDockerfile, /EXPOSE 3200/)
})

test('Go binaries embed their required timezone data', async () => {
  const tzcheck = await read('backend-go/internal/tzcheck/tzcheck.go')
  const gateway = await read('backend-go/cmd/gateway/main.go')
  const worker = await read('backend-go/cmd/worker/main.go')
  assert.match(tzcheck, /_ "time\/tzdata"/)
  assert.match(tzcheck, /Asia\/Shanghai/)
  assert.match(gateway, /tzcheck\.Ensure\(\)/)
  assert.match(worker, /tzcheck\.Ensure\(\)/)
})

test('deployments stay paused until explicitly re-enabled', async () => {
  const workflow = await read('.github/workflows/deploy-dashboard.yml')
  const localDeploy = await read('deploy/deploy-local.sh')
  assert.match(workflow, /DEPLOYMENTS_ENABLED/)
  assert.match(workflow, /Deployments are paused/)
  assert.match(localDeploy, /DEPLOYMENTS_ENABLED/)
  assert.match(localDeploy, /Deployments are paused/)
})

test('deploy free-space policy uses configurable absolute floors', async () => {
  const script = await read('deploy/deploy-remote.sh')
  assert.match(script, /DEPLOY_FREE_SPACE_MIN_BYTES/)
  assert.match(script, /DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES/)
  assert.match(script, /DEPLOY_FREE_SPACE_PERCENT/)
  assert.doesNotMatch(script, /DEPLOY_FREE_SPACE_PERCENT=10/)
})

test('dashboard deployment workflow is manual-only and publishes the Go API and Web images', async () => {
  const workflow = await read('.github/workflows/deploy-dashboard.yml')
  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /^on:\s*\n\s+push:/m)
  assert.match(workflow, /packages:\s*write/)
  assert.match(workflow, /secrets\.GHCR_TOKEN/)
  assert.match(workflow, /ghcr\.io\/passwii\/believeboydashboard-go-api/)
  assert.match(workflow, /ghcr\.io\/passwii\/believeboydashboard-web/)
  assert.doesNotMatch(workflow, /ghcr\.io\/passwii\/believeboydashboard-api/)
  assert.match(workflow, /file: backend-go\/Dockerfile/)
  assert.match(workflow, /file: frontend\/Dockerfile/)
  assert.doesNotMatch(workflow, /backend\/Dockerfile/)
  assert.match(workflow, /secrets\.NEXTAUTH_SECRET/)
  assert.match(workflow, /secrets\.GO_API_TRUSTED_PROXY_SECRET/)
  assert.match(workflow, /steps\.go_api\.outputs\.digest/)
  assert.match(workflow, /steps\.web\.outputs\.digest/)
  assert.doesNotMatch(workflow, /steps\.api\.outputs\.digest/)
})

test('remote deploy keeps the SSH script stream out of Compose run', async () => {
  const script = await read('deploy/deploy-remote.sh')
  const workflow = await read('.github/workflows/deploy-dashboard.yml')
  const localDeploy = await read('deploy/deploy-local.sh')
  assert.match(script, /docker compose run --rm -T migrate < \/dev\/null/)
  assert.doesNotMatch(script, /docker compose run --rm migrate/)
  assert.doesNotMatch(workflow, /bash -s/)
  assert.doesNotMatch(localDeploy, /bash -s/)
  assert.match(script, /docker compose[^\n]*pull migrate go-api go-worker go-scheduler web/)
  assert.match(localDeploy, /build_go_api/ )
  assert.match(localDeploy, /IMAGE_BUILD_SECONDS/ )
  assert.match(script, /PUBLIC_WEB_HEALTH_URL/)
  assert.match(script, /PUBLIC_API_HEALTH_URL/)
  // 2026-11-10：远程脚本改为「暂存目录 + .deploy.lock」方案，工作流按原名上传 deploy-remote.sh。
  assert.match(workflow, /deploy\/deploy-remote\.sh/)
  assert.match(workflow, /STAGING_DIR\/deploy-remote\.sh/)
  assert.match(workflow, /PUBLIC_WEB_HEALTH_URL/)
  assert.match(workflow, /PUBLIC_API_HEALTH_URL/)
  assert.match(localDeploy, /\.deploy-staging\./)
  assert.match(localDeploy, /\.deploy\.lock/)
  assert.match(localDeploy, /TMP_DIR\/web\.env/)
  assert.match(localDeploy, /TMP_DIR\/go\.env/)
  // 2026-11-10：部署门禁改为 DB 感知，且启用接管时要做 owned-route 冒烟。
  assert.match(script, /\/api\/v1\/health\/ready/)
  assert.match(script, /verify_owned_routes/)
  assert.match(script, /GO_API_OWNED_MODULES/)
  assert.match(script, /GO_API_INTERNAL_URL/)
  assert.match(workflow, /health\/ready/)
})

test('server-side backend calls prefer loopback while browser metadata stays public', async () => {
  const envExample = await read('deploy/web.env.example')
  const goEnvExample = await read('deploy/go.env.example')
  const backendApi = await read('frontend/lib/server/backend-api.ts')
  // 2026-11-10：FastAPI 已下线；Web 的 loopback 后端固定为 Go gateway 8200。
  // go.env 仅保留 FASTAPI_ORIGIN 以满足网关配置校验，没有服务监听 8100。
  assert.match(envExample, /^BACKEND_INTERNAL_URL=http:\/\/127\.0\.0\.1:8200$/m)
  assert.doesNotMatch(envExample, /^BACKEND_INTERNAL_URL=http:\/\/127\.0\.0\.1:8100$/m)
  assert.match(goEnvExample, /^GO_API_ADDR=127\.0\.0\.1:8200$/m)
  assert.match(goEnvExample, /^FASTAPI_ORIGIN=http:\/\/127\.0\.0\.1:8100$/m)
  assert.match(goEnvExample, /^GO_API_OWNED=$/m)
  assert.match(envExample, /^BACKEND_PUBLIC_API_BASE_URL=https:\/\/dash-api\.believeboy\.com$/m)
  assert.match(backendApi, /process\.env\.BACKEND_INTERNAL_URL/)
  assert.match(backendApi, /process\.env\.BACKEND_PUBLIC_API_BASE_URL/)
  assert.match(backendApi, /process\.env\.GO_API_TRUSTED_PROXY_SECRET/)
})

test('deployment health endpoint is available outside the auth matcher', async () => {
  const route = await read('frontend/app/healthz/route.ts')
  const proxy = await read('frontend/proxy.ts')
  assert.match(route, /new Response\(['"]ok\\n['"]/)
  assert.match(proxy, /matcher:\s*\[['"]\/login['"],\s*['"]\/dashboard\/:path\*['"]\]/)
})
