#!/usr/bin/env node
/**
 * gen:api-types — wraps `openapi-typescript` with the project's CI contract.
 *
 * Pipeline position (BEL-22-3 / BEL-29):
 *   1. Backend dumps Pydantic schemas → frontend/types/api-generated/openapi.json
 *      (see backend/Makefile `openapi-export`).
 *   2. THIS SCRIPT turns that JSON into api.d.ts.
 *   3. `pnpm gen:api-types --check` (or `pnpm build`) refuses to proceed if
 *      api.d.ts is out of date — forcing devs to regenerate + commit.
 *
 * Why a wrapper around openapi-typescript? Two reasons:
 *   - Centralize the input/output paths so they're not duplicated across
 *     package.json, this script, and CI.
 *   - `--check` mode is the only one that should be called from `pnpm build`.
 *     `pnpm gen:api-types` (no flag) regenerates the file in place.
 *
 * The JSON file is git-tracked on purpose: it lets the frontend build with no
 * backend running, and makes contract changes reviewable in a PR diff.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FRONTEND_ROOT = resolve(__dirname, '..')

const INPUT = resolve(FRONTEND_ROOT, 'types/api-generated/openapi.json')
const OUTPUT = resolve(FRONTEND_ROOT, 'types/api-generated/api.d.ts')

const args = process.argv.slice(2)
const check = args.includes('--check')

if (!existsSync(INPUT)) {
  console.error(
    `[gen:api-types] Missing input: ${INPUT}\n` +
      'Run `make openapi-export` from the backend directory (or `python -m scripts.openapi_export --out <path>`) to generate the OpenAPI JSON first.',
  )
  process.exit(2)
}

const cliArgs = [INPUT, '--output', OUTPUT]
if (check) cliArgs.push('--check')

const result = spawnSync(
  resolve(FRONTEND_ROOT, 'node_modules/.bin/openapi-typescript'),
  cliArgs,
  { stdio: 'inherit', cwd: FRONTEND_ROOT },
)

if (result.error) {
  console.error(`[gen:api-types] Failed to invoke openapi-typescript: ${result.error.message}`)
  process.exit(1)
}

if (result.status !== 0) {
  if (check) {
    console.error(
      '[gen:api-types] Drift detected: api.d.ts does not match the current openapi.json.\n' +
        'Run `pnpm gen:api-types` to regenerate, then commit the result.',
    )
  }
  process.exit(result.status ?? 1)
}

if (check) {
  console.log('[gen:api-types] OK — generated types are in sync with openapi.json.')
} else {
  console.log(`[gen:api-types] Wrote ${OUTPUT}`)
}
