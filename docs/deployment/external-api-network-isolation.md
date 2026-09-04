# External API — Network Isolation (P0)

> **命名空间说明（2026-08）**：`/api/v1/external/*` 正被 `/api/v1/agent/*`
> 取代（见 [`docs/agent-api-design.md`](../agent-api-design.md)）。新命名空间
> **沿用本文档的同一网关隔离策略**——agent 通道虽有应用层 Bearer 鉴权，
> 网关白名单仍是纵深防御的 backstop；配置时把 `/api/v1/agent/*` 与
> `/api/v1/external/*` 一并纳入即可。

The `/api/v1/external/*` namespace is **whitelisted read-only** for
internal BI tools and data analysts. It has **no application-layer
authentication** in P0 — see
[`backend/docs/external-api.md`](../../backend/docs/external-api.md)
for the full P0 contract.

> ⚠️ **Until P1 adds API key auth, you MUST restrict `/api/v1/external/*`
> to trusted source IPs at the gateway.**

This document provides copy-pasteable configs for the two gateways used
by this project: **Traefik** (Coolify / Dokploy production deploy) and
**Nginx** (alternative / direct VPS setup).

---

## 1. Traefik (production — recommended)

The project deploys behind **Traefik** via Coolify / Dokploy
(see [`coolify-deployment.md`](./coolify-deployment.md) and
[`dokploy-deployment.md`](./dokploy-deployment.md)). Traefik has a
native `ipwhitelist` middleware — preferred over Nginx because no extra
process to maintain.

### 1.1 Coolify / Docker labels

Add the following labels to the **backend container** (in Coolify's
`Docker Compose` or `Environment Variables > Labels` UI):

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.backend.rule=Host(`api.believeboy.com`) && PathPrefix(`/api/`)"
  - "traefik.http.routers.backend.entrypoints=websecure"
  - "traefik.http.routers.backend.tls.certresolver=cloudflare"

  # Whitelist middleware for /api/v1/external/*
  - "traefik.http.middlewares.ext-ipwhitelist.ipwhitelist.sourcerange=10.0.0.0/8, 192.168.0.0/16, 203.0.113.42"

  # Dedicated router that scopes /external/* to the IP whitelist
  - "traefik.http.routers.backend-ext.rule=Host(`api.believeboy.com`) && PathPrefix(`/api/v1/external/`)"
  - "traefik.http.routers.backend-ext.entrypoints=websecure"
  - "traefik.http.routers.backend-ext.tls.certresolver=cloudflare"
  - "traefik.http.routers.backend-ext.middlewares=ext-ipwhitelist"
  - "traefik.http.routers.backend-ext.service=backend"
  - "traefik.http.services.backend.loadbalancer.server.port=8100"
```

`ext-ipwhitelist` returns **403 Forbidden** for any client IP not in the
allow-list. Adjust the CIDR ranges to match your BI team's source IPs
(office VPN, internal services, partner static IPs, etc.).

> Note: the regular `backend` router still serves other paths
> (`/api/v1/projects`, `/api/v1/auth`, etc.) without IP restriction —
> the existing X-Operator header auth still applies there.

### 1.2 Traefik file provider (advanced)

If you use a static Traefik config file, add:

```yaml
# /etc/traefik/dynamic/external-whitelist.yml
http:
  middlewares:
    ext-ipwhitelist:
      ipwhitelist:
        sourcerange: "10.0.0.0/8, 192.168.0.0/16, 203.0.113.42"

  routers:
    backend-ext:
      rule: "Host(`api.believeboy.com`) && PathPrefix(`/api/v1/external/`)"
      entryPoints: [websecure]
      tls:
        certresolver: cloudflare
      middlewares: [ext-ipwhitelist]
      service: backend

  services:
    backend:
      loadBalancer:
        servers:
          - url: "http://backend:8100"
```

Then add to `traefik.yml`:

```yaml
providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true
```

---

## 2. Nginx (alternative)

If your VPS uses Nginx directly (not Traefik), drop this into
`/etc/nginx/conf.d/believeboy-external-api.conf`:

```nginx
upstream believeboy_api_external {
    server 127.0.0.1:8100;
    keepalive 32;
}

server {
    listen 8443 ssl http2;
    server_name api-ext.believeboy.com;

    ssl_certificate     /etc/ssl/cloudflare-origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare-origin.key;

    real_ip_header    CF-Connecting-IP;
    real_ip_recursive on;

    # Block everything by default
    location / {
        return 403;
    }

    # Allow only the external namespace from whitelisted IPs
    location /api/v1/external/ {
        # Edit these to match your BI team's source IPs
        allow 10.0.0.0/8;
        allow 192.168.0.0/16;
        allow 203.0.113.42;
        deny  all;

        proxy_pass         http://believeboy_api_external;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Connection        "";

        proxy_connect_timeout 5s;
        proxy_read_timeout    30s;
    }
}
```

Reload: `sudo nginx -t && sudo systemctl reload nginx`.

---

## 3. Uvicorn `--proxy-headers`

When clients connect through Cloudflare + Traefik (or Nginx), the FastAPI
process must trust the `X-Forwarded-For` header so access logs show the
**real client IP** (not the gateway IP). Currently the systemd unit
(`backend/deploy/systemd/believeboy-api.service`) does not set
`--proxy-headers`, so `request.client.host` shows the loopback / gateway
address.

To fix, edit the systemd unit:

```ini
[Service]
ExecStart=/root/believeboyDashboard/backend/.venv/bin/uvicorn \
    app.main:app \
    --host 0.0.0.0 \
    --port 8100 \
    --proxy-headers        # <-- add this
    --forwarded-allow-ips="*"  # <-- and this if behind multiple proxies
```

Reload systemd: `sudo systemctl daemon-reload && sudo systemctl restart believeboy-api`.

`backend/app/main.py:103-153` already lists `X-Forwarded-For` and
`X-Forwarded-Proto` as allowed CORS headers, so no code change is needed.

---

## 4. Verifying the isolation

After applying the gateway config, verify from a non-whitelisted IP:

```bash
# Should return 403 Forbidden
curl -i https://api.believeboy.com/api/v1/external/projects

# From a whitelisted IP, should return 200 + JSON list
curl -i https://api.believeboy.com/api/v1/external/projects
```

If you see 200 from the wrong IP, double-check:
1. The middleware is attached to the **right router** (the one matching
   `PathPrefix('/api/v1/external/')`).
2. The CIDR range is correct — `0.0.0.0/0` would whitelist the whole
   internet.
3. Traefik / Nginx was reloaded after the config change.