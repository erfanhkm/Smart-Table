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
cp .env.example .env   # then fill SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, ENCRYPTION_KEY

# Easiest local run (no docker needed, in-memory DB):
PG_MEM=1 npm run dev

# With real Postgres:
docker compose up --build
```

Then: `npm run seed` → prints guest QR links + dashboard URL.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with auto-reload (tsx watch) |
| `npm run migrate` | Apply `migrations/*.sql` |
| `npm run seed` | Demo merchant + location + tables T1–T4 with QR links |
| `npm run smoke` | **End-to-end test**: boots the API (in-memory DB), creates a real sandbox order, links it to a table, resolves the QR, pays $10 + $14 through our endpoints, asserts COMPLETED, overpay rejection, webhook dedup, waiter call + metrics. Needs `SQUARE_ACCESS_TOKEN` + `SQUARE_LOCATION_ID`. |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run typecheck` | `tsc --noEmit` |

## API map

| Method & path | Purpose |
|---|---|
| `GET /healthz` | Health check |
| `GET /api/oauth/start` → `GET /api/oauth/callback` | Square OAuth restaurant onboarding (stores encrypted tokens) |
| `GET/POST /api/tables`, `GET /api/tables/:id/qr` | Table CRUD + printable QR PNG |
| `POST /api/tables/:id/link-check` | Staff links a POS order to a table |
| `POST /api/tables/:id/free`, `/ack-call` | Reset table / ack waiter call |
| `GET /api/t/:token` | Guest QR resolve → table + live bill |
| `GET /api/checks/:orderId` | Bill detail (items, tenders, remaining) |
| `POST /api/checks/:orderId/pay` | Pay: `{mode: full\|equal\|items\|custom, amount_cents?, tip_cents?, card_nonce?}` |
| `POST /api/tables/:id/call-waiter` | Guest calls waiter |
| `GET /api/dashboard/overview` | Live floor: tables, open checks, waiter calls |
| `GET /api/dashboard/metrics` | Avg settlement time, waiter response |
| `POST /api/webhooks/square` | `order.updated` / `payment.updated` (HMAC-verified, idempotent) |
| `GET /api/locations`, `GET /api/square-open-orders` | Staff helpers |

## Payment flow (the important part)

`POST /pay` runs inside a DB transaction with a row lock on the check:
1. Reads **live** remaining from Square tenders (source of truth).
2. Rejects `amount > remaining` (kills double-pay races).
3. Creates the Square payment with a stored idempotency key (`card_nonce` or `EXTERNAL`).
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
  http.ts             # error helper
  services/
    payments.ts       # pay orchestration (split, lock, idempotency)
    floor.ts          # table/check/waiter-call views
  routes/             # tables, customer, dashboard, staff, oauth, webhooks
migrations/001_init.sql
public/t/index.html        # guest bill + pay + tip + waiter call
public/dashboard/index.html # staff live floor + metrics
scripts/seed.ts scripts/smoke.ts scripts/migrate-cli.ts
```

## What's next (not in this skeleton)

- **Card payments** via Square Web Payments SDK: the `card_nonce` path exists in `payCheck`, but card partial-capture + `PayOrder` must be re-verified in the sandbox during pilot hardening (the spike proved `EXTERNAL`; cards are the production path).
- OAuth **token refresh** job (tokens expire).
- **Reconciliation** job: periodic sync of OPEN checks vs Square (safety net for missed webhooks).
- Real-time staff push (SSE/websocket) instead of 5s polling.
- Dashboard **auth** (currently open — fine for local dev, not for production).
- FK constraints in the DB (omitted for pg-mem portability).

## Security notes

- `SQUARE_ACCESS_TOKEN` / `ENCRYPTION_KEY` never go in git (`.env` is gitignored; `.env.example` is the template).
- OAuth tokens are AES-256-GCM encrypted at rest.
- Webhook HMAC-SHA256 verification is enforced when `SQUARE_WEBHOOK_SIGNATURE_KEY` is set.
- Every Square write carries a stored idempotency key; webhook deliveries are deduped by `event_id`.
