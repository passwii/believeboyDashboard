// k6 stress test scenarios for BelieveBoy Dashboard backend
// Usage: k6 run k6_baseline.js
//        k6 run k6_baseline.js --out json=results.json
// Install: brew install k6  (macOS)

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Custom metrics ─────────────────────────────────────────────────────────────
const errorRate = new Rate('errors');
const apiLatency = new Trend('api_latency_ms');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8000';
const API_KEY = __ENV.API_KEY || 'AIRGSl5Il386jowa80OP9GnOCK8tkbkZGYEEOGnYKQWtPGlI';
const PROJECT_NAME = __ENV.PROJECT_NAME || 'TestProject';

// ── Shared headers ────────────────────────────────────────────────────────────
const makeHeaders = (extra = {}) => ({
  'Content-Type': 'application/json',
  'X-API-Key': API_KEY,
  'X-Operator': 'k6-stress-test',
  'X-User-Id': 'k6-user',
  'X-User-Name': 'k6',
  'X-Is-Admin': 'false',
  ...extra,
});

// ── Thresholds ─────────────────────────────────────────────────────────────────
export const thresholds = {
  http_req_duration: ['p(95)<2000', 'p(99)<5000'],
  http_req_failed: ['rate<0.005'],
  errors: ['rate<0.01'],
  api_latency: ['p(95)<1500'],
};

// ── Scenarios ──────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    baseline_10vu: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 5 },
        { duration: '60s', target: 5 },
        { duration: '30s', target: 10 },
        { duration: '120s', target: 10 },
        { duration: '30s', target: 0 },
      ],
      tags: { scenario: 'baseline_10vu' },
    },
    saturation_50vu: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 20 },
        { duration: '60s', target: 20 },
        { duration: '20s', target: 50 },
        { duration: '120s', target: 50 },
        { duration: '30s', target: 0 },
      ],
      tags: { scenario: 'saturation_50vu' },
    },
    endurance_20vu: {
      executor: 'constant-vus',
      vus: 20,
      duration: '30m',
      tags: { scenario: 'endurance_20vu' },
    },
  },
  httpDebug: __ENV.K6_DEBUG ? 'full' : '',
};

// ── Request helper ─────────────────────────────────────────────────────────────
function apiRequest(method, path, body, tags = {}) {
  const url = BASE_URL + path;
  const headers = makeHeaders();
  const start = Date.now();

  let res;
  try {
    res = body !== undefined
      ? http.request(method, url, JSON.stringify(body), { headers })
      : http.request(method, url, null, { headers });
  } catch (e) {
    errorRate.add(1, tags);
    return null;
  }

  const elapsed = Date.now() - start;
  apiLatency.add(elapsed, tags);

  const ok = check(res, {
    [`${method} ${path} 2xx`]: (r) => r && r.status >= 200 && r.status < 300,
    [`${method} ${path} no-5xx`]: (r) => r && r.status < 500,
  });

  if (!ok) {
    errorRate.add(1, tags);
    console.error(`[ERROR] ${method} ${path} → ${res ? res.status : 'network error'}`);
  }

  return res;
}

// ── Scenario A: Daily mixed operations ────────────────────────────────────────
export function scenarioDailyMixed() {
  group('daily-mixed', () => {
    apiRequest('GET', `/api/v1/sku-info?page=1&page_size=100&project_name=${encodeURIComponent(PROJECT_NAME)}`);
    apiRequest('GET', `/api/v1/shipment-schedules?page=1&page_size=20&project_name=${encodeURIComponent(PROJECT_NAME)}`);
    apiRequest('GET', '/api/v1/ai/conversations?page=1&page_size=20');
    apiRequest('GET', `/api/v1/exchange-rates?page=1&page_size=50`);
    sleep(Math.random() * 2 + 0.5);
  });
}

// ── Scenario B: Report peak (month-end wide date range) ───────────────────────
export function scenarioReportPeak() {
  group('report-peak', () => {
    apiRequest('GET', `/api/v1/sku-info?page=1&page_size=1000&project_name=${encodeURIComponent(PROJECT_NAME)}`);
    apiRequest('GET', `/api/v1/shipment-schedules?page=1&page_size=100&project_name=${encodeURIComponent(PROJECT_NAME)}`);
    sleep(Math.random() * 3 + 1);
  });
}

// ── Scenario C: Connection saturation probe ────────────────────────────────────
export function scenarioSaturationProbe() {
  group('saturation', () => {
    // Heavy list queries that hold a DB connection
    apiRequest('GET', `/api/v1/sku-info?page=1&page_size=1000&project_name=${encodeURIComponent(PROJECT_NAME)}`);
    apiRequest('GET', `/api/v1/shipment-schedules?page=1&page_size=100&project_name=${encodeURIComponent(PROJECT_NAME)}`);
    apiRequest('GET', `/api/v1/exchange-rates?page=1&page_size=200`);
    sleep(0.2);
  });
}

// ── Default executor: rotate scenarios ────────────────────────────────────────
export default function () {
  const phase = __VU % 3;
  if (phase === 0) scenarioDailyMixed();
  else if (phase === 1) scenarioReportPeak();
  else scenarioSaturationProbe();
}