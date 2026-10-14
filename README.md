# Smart Table — MVP app skeleton (v0.1)

اسکلت واقعی و اجراشونده‌ی اپلیکیشن Smart Table: بک‌اند + وب‌اپ مهمان + داشبورد کارکنان، متصل به Square. این نسخه روی sandbox تست شده و کل فلو پرداخت سرتاسری از API خودمان سبز است (`npm run smoke`).

## What this is

- **Backend:** Node.js 24 + TypeScript + Fastify 5 + Postgres 16 (via `pg`).
- **Square integration:** fetch-based typed client (`src/square.ts`) — no SDK version surprises. Every call was verified live against the Square sandbox.
- **Frontends:** zero-build static pages — guest bill/pay (`/t/:token`) and staff dashboard (`/dashboard`).
- **DB:** migrations in `migrations/`; `PG_MEM=1` runs everything on an in-memory DB for tests.

## Quickstart

```bash
cd app
npm install
cp .env.example .env   # then fill SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, ENCRYPTION_KEY, STAFF_API_TOKEN (openssl rand -hex 32)

# Easiest local run (no docker needed, in-memory DB):
PG_MEM=1 npm run dev

# With real Postgres (needs POSTGRES_PASSWORD + STAFF_API_TOKEN; add NODE_ENV=development for local play):
NODE_ENV=development docker compose up --build
```

The staff dashboard (`/dashboard`) asks for `STAFF_API_TOKEN` on load and sends it as `Authorization: Bearer ...` to every staff endpoint.

Then: `npm run seed` → prints guest QR links + dashboard URL.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with auto-reload (tsx watch) |
| `npm run migrate` | Apply `migrations/*.sql` |
| `npm run seed` | Demo merchant + location + tables T1–T4 with QR links |
| `npm run smoke` | **End-to-end test**: boots the API (in-memory DB), creates a real sandbox order, links it to a table, resolves the QR, checks the auth / validation gates, records $10 + $14 cash through the staff endpoint (idempotent replay included), asserts COMPLETED, overpay/tip rejection, wrong-location link refusal, webhook dedup, waiter call + metrics. `SMOKE_CARD=1` additionally tries the guest card path with the sandbox test nonce (informational). Needs `SQUARE_ACCESS_TOKEN` + `SQUARE_LOCATION_ID`. |
| `npm run build` / `npm start` | Compile `src/` to `dist/` (via `tsconfig.build.json`) and run |
| `npm run migrate:prod` | Apply migrations from the compiled build (`node dist/migrate-cli.js`) |
| `npm run typecheck` | `tsc --noEmit` |

## API map

**Staff** = requires `Authorization: Bearer $STAFF_API_TOKEN` (401 JSON otherwise). **Public** = no auth.

| Access | Method & path | Purpose |
|---|---|---|
| Public | `GET /healthz` | Health check |
| Staff | `POST /api/oauth/start` → `GET /api/oauth/callback` (public) | Square OAuth restaurant onboarding (stores encrypted tokens) |
| Staff | `GET /api/tables?location_id=`, `POST /api/tables`, `GET /api/tables/:id/qr` | Table list / create / printable QR PNG |
| Staff | `POST /api/tables/:id/link-check` | Link a POS order to a table (order is fetched from Square; must be OPEN and in the table's Square location) |
| Staff | `POST /api/tables/:id/free`, `/ack-call` | Reset table / ack waiter call |
| Staff | `POST /api/checks/:orderId/record-external-payment` | Record cash / outside-rail payment: `{mode, amount_cents?, tip_cents?, idempotency_key}` |
| Staff | `GET /api/dashboard/overview?location_id=`, `GET /api/dashboard/metrics?location_id=` | Live floor / service metrics (location_id required) |
| Staff | `GET /api/locations`, `GET /api/square-open-orders?location_id=` | Helpers |
| Public | `GET /api/t/:token` | Guest QR resolve → table + live bill |
| Public | `GET /api/checks/:orderId` | Bill detail of a **linked** check |
| Public | `POST /api/checks/:orderId/pay` | Card pay: `{mode: full\|equal\|items\|custom, amount_cents?, tip_cents?, card_nonce (required, cnon:…), idempotency_key (required, UUID v4)}` |
| Public | `POST /api/tables/:id/call-waiter` | Guest calls waiter |
| Public | `POST /api/webhooks/square` | `order.updated` / `payment.updated` (HMAC-verified, idempotent) |

## Payment flow (the important part)

`POST /pay` runs inside a DB transaction with a row lock on the check:
1. Reads **live** remaining from Square tenders (source of truth).
2. Rejects `amount > remaining` (kills double-pay races).
3. Creates the Square payment (guest: `card_nonce`; staff cash: `EXTERNAL` via `record-external-payment` only). The client-supplied `idempotency_key` is reserved as a `PENDING` row *before* the transaction and reused as the Square idempotency key: a repeated key returns the stored result and never charges twice.
4. When balance hits zero → `PayOrder` → check COMPLETED, table PAID.

## Project structure

```
src/
  index.ts            # app bootstrap + static serving
  config.ts           # env
  db.ts               # pg pool / pg-mem switch, withTx
  migrate.ts          # migration runner
  square.ts           # Square REST client (sandbox-proven calls)
  crypto.ts           # AES-256-GCM token encryption, webhook HMAC verify
  http.ts             # error helpers (4xx message exposed, 5xx generic)
  auth.ts             # staff bearer-token guard
  services/
    payments.ts       # pay orchestration (split, lock, idempotency)
    floor.ts          # table/check/waiter-call views
  routes/             # tables, customer, dashboard, staff, oauth, webhooks
migrations/001_init.sql, 002_payments_idempotency_merchant.sql
public/t/index.html        # guest bill + pay + tip + waiter call
public/dashboard/index.html # staff live floor + metrics
scripts/seed.ts scripts/smoke.ts scripts/migrate-cli.ts
```

## What's next (not in this skeleton)

- **Card payments** via Square Web Payments SDK: the `card_nonce` path exists in `payCheck`, but card partial-capture + `PayOrder` must be re-verified in the sandbox during pilot hardening (the spike proved `EXTERNAL`; cards are the production path).
- OAuth **token refresh** job (tokens expire).
- **Reconciliation** job: periodic sync of OPEN checks vs Square (safety net for missed webhooks).
- Real-time staff push (SSE/websocket) instead of 5s polling.
- Per-user staff auth / RBAC, per-merchant Square tokens (all Square calls still use the one `SQUARE_ACCESS_TOKEN`), QR session rotation, rate limiting, card SCA verification tokens.
- FK constraints in the DB (omitted for pg-mem portability).

## Security notes

- `SQUARE_ACCESS_TOKEN` / `ENCRYPTION_KEY` never go in git (`.env` is gitignored; `.env.example` is the template).
- OAuth tokens are AES-256-GCM encrypted at rest.
- With `NODE_ENV=production` the app **refuses to boot** unless `SQUARE_WEBHOOK_SIGNATURE_KEY` and `STAFF_API_TOKEN` (>= 32 chars) are set and `PG_MEM` is not `1`. Outside production an unsigned webhook is accepted with a loud warning per request.
- Behind a reverse proxy set `TRUST_PROXY=1`: the webhook signature URL is then built from `X-Forwarded-Proto/Host`.
- Every Square ID is validated against `^[A-Za-z0-9_-]+$` and URL-encoded before it reaches a Square path.
- 5xx responses are generic (details only in the server log); webhook deliveries are deduped by `event_id`.
