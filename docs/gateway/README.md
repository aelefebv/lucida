# Step 11 Gateway Runbook

## Purpose
`lucida_gateway` exposes active daemon sessions to a browser over a token-protected WebSocket channel.

## Startup

```bash
python -m lucida_gateway serve \
  --host 127.0.0.1 \
  --port 8765 \
  --token step11token \
  --local-ipc-uri unix_socket:///tmp/lucida.sock
```

Equivalent token env var:

```bash
export LUCIDA_GATEWAY_TOKEN=step11token
python -m lucida_gateway serve --host 127.0.0.1 --port 8765
```

## Endpoints
1. `GET /healthz`
2. `GET /v1/ws` (requires token)

## Authentication
1. Preferred: `Authorization: Bearer <token>`.
2. Browser fallback for local testing: `?token=<token>` query parameter.

Invalid or missing tokens return `401` (or connection rejection during WS upgrade).

## Security Posture
1. Default bind is localhost only.
2. Non-localhost bind requires `--tls-termination`.
3. Use reverse proxy TLS termination (for example nginx/caddy/traefik) for remote exposure.
4. Single active controller is enforced per session.

## Reverse Proxy Example (nginx)

```nginx
server {
  listen 443 ssl;
  server_name lucida.example.internal;

  ssl_certificate /etc/ssl/certs/lucida.crt;
  ssl_certificate_key /etc/ssl/private/lucida.key;

  location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Authorization $http_authorization;
  }
}
```

## Reference Client
A minimal client lives under:

- `docs/web-gateway/reference-client/index.html`
- `docs/web-gateway/reference-client/app.js`
- `docs/web-gateway/reference-client/styles.css`

It demonstrates attach, RPC relay, and tile rendering behavior.
