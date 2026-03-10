# PostCall POC — Phase 2 + Phase 3 + Phase 4: Universal Proxy, Grounding, Auth, RAG

## What this does

- **Mock backend** (`mock-backend.js`): Implements the API from `specs/sample-oas-plus.yaml` — org search, project lookup, PATCH settings. Optional: set `REQUIRE_AUTH=1` to make PATCH return 401 until credentials are sent (Phase 3 demo).
- **Universal Proxy** (`universal-proxy.js`): Loads the OAS++ spec, runs grounding, executes the primary operation. **Phase 3:** Auth discovery, 401 handling, credentials. **Phase 4:** RAG index from `x-agent-guidance`; **POST /query** (natural language → operationId) and **POST /execute-by-intent** (query + intent + body → full run).

No IDs are supplied by the caller; the proxy resolves "Acme Corp" → `org_8821` and "Marketing" → `proj_abc_123` via the grounding steps, then calls `PATCH .../settings`.

## Quick run

**Phase 2 (grounding only):**
```bash
npm run demo
```
Starts the mock and proxy and sends one `POST /execute` request. You should see the grounding steps (2) and the primary PATCH result.

**Phase 3 (auth discovery + 401 → retry with credentials):**
```bash
npm run demo:phase3
```
Starts the mock with `REQUIRE_AUTH=1`, then: (1) POST /execute without credentials → 401 with `auth_discovery`; (2) GET /auth-info; (3) POST /execute with credentials → 200.

**Phase 4 (natural language → RAG → execute):**
```bash
npm run demo:phase4
```
Starts the mock and proxy, then: (1) POST /query with a natural language sentence → returns matching operation(s); (2) POST /execute-by-intent with same query + intent + body → RAG selects operation, runs grounding, executes primary call.

## Run mock and proxy separately

**Terminal 1 — mock (port 3001):**
```bash
npm run mock
```

**Terminal 2 — proxy (port 3000):**
```bash
npm run proxy
```

**Call the proxy:**
```bash
curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{
    "operationId": "update_project_settings",
    "intent": { "org_name": "Acme Corp", "project_name": "Marketing" },
    "body": { "notifications_enabled": true, "timezone": "America/New_York" }
  }'
```

## Endpoints

- **POST /execute** — Run an operation by ID with intent and optional body; credentials optional (Phase 3).
- **POST /query** (Phase 4) — Body: `{ "query": "natural language" }`. Returns `{ query, results: [{ operationId, score, summary, matched_text }, ...] }`.
- **POST /execute-by-intent** (Phase 4) — Body: `{ "query", "intent", "body" }`. RAG selects operation from query, then runs grounding + primary call. Credentials optional.
- **GET /auth-info** — Returns `auth_discovery` from the spec (metadata_url, registration_url, provisioning_url).
- **GET /health** — Liveness.

## Request shape (POST /execute)

- **operationId** (required): Must match an operation in the loaded OAS++ spec (e.g. `update_project_settings`).
- **intent** (object): Keys match `{{intent.*}}` in the grounding step parameters (e.g. `org_name`, `project_name`).
- **body** (optional): Request body for the primary operation (PATCH/POST/PUT).
- **credentials** (optional, Phase 3): `{ type: "bearer", token: "..." }` or `{ type: "api_key", key: "..." }`. Alternatively, send `Authorization` or `X-API-Key` HTTP header.

On 401 from the backend, the proxy responds with 401 and a JSON body containing `auth_required: true`, `code: "auth_required_challenge"`, and `auth_discovery` so the client can obtain credentials and retry.

## Environment

- `BACKEND_BASE`: Base URL for the API the proxy calls (default `http://localhost:3001`).
- **Mock:** `REQUIRE_AUTH=1` to require `Authorization: Bearer demo-token` or `X-API-Key: demo-key` for PATCH /settings.
