# Deployment

A cslug app has up to **three roles**, all from the same code and the same image:

| Role | Command | Scale |
|---|---|---|
| web | `cslug serve` | N instances behind a load balancer |
| worker | `cslug queue:work` (optionally per queue: `--queue=payments --concurrency=1`) | N |
| scheduler | `cslug schedule:work` | 1 is enough; >1 is safe (once-per-tick locking) |

**They do not need separate machines.** There are three ways to run them, from simplest to most isolated.

## Three process models

### 1. One process: `cslug serve --with-worker --with-scheduler`

The HTTP server, the queue worker and the scheduler share **one Bun process** and one event loop.

```bash
cslug serve --with-worker --with-scheduler
```

This works because the worker and the scheduler are mostly **waiting on I/O**: the worker blocks on
`XREADGROUP` on its own Redis connection, and the scheduler wakes once a minute. Neither holds the event loop
while idle, so requests keep flowing.

| ✓ | ✗ |
|---|---|
| One process, one log stream, smallest memory footprint | A CPU-heavy job (PDF, image resize, a big report) **delays HTTP responses** while it runs |
| Nothing to supervise | A crash in job code (out of memory, native module fault) takes the web server down too |
| One `SIGTERM` drains everything | Uses one CPU core |

Use it for development, previews, and small deployments where jobs are I/O-bound (sending mail, calling APIs,
DB updates), which describes all of the pilot app's MVP jobs.

### 2. One container, several processes: `cslug start` (recommended for a single instance)

`cslug start` is a small **built-in supervisor**. It starts each role as a **separate Bun child process**
(`Bun.spawn`), restarts any that crash (with backoff), forwards `SIGTERM` to all of them, and exits when they have
all drained.

```bash
cslug start                                        # web + worker + scheduler (the default)
cslug start --web --worker=2 --scheduler           # two worker processes
cslug start --worker=payments:1 --worker=default,notifications:1
```

Or declare it once:

```ts
// cslug.config.ts
export default defineCslugConfig({
  processes: {
    web: { instances: 1 },
    worker: [
      { queues: ['payments'], concurrency: 1 },              // serial money work
      { queues: ['default', 'notifications'], concurrency: 10 },
    ],
    scheduler: true,
  },
})
```

```
$ cslug start
  cslug  start  (supervisor pid 1)
  ➜ web        pid 12  http://0.0.0.0:3000
  ➜ worker#1   pid 13  queues: payments (concurrency 1)
  ➜ worker#2   pid 14  queues: default, notifications (concurrency 10)
  ➜ scheduler  pid 15  4 entries
```

| ✓ | ✗ |
|---|---|
| A slow or crashing job **cannot block or kill** the web server | More memory (each process loads the app, typically 60–120 MB) |
| Uses several CPU cores | |
| Still **one container / one Railway service** | |
| Logs from every process go to stdout, prefixed with the role (`[worker#1]`) | |

**Why not pm2?** pm2 works (`pm2-runtime` with `interpreter: 'bun'`), but it adds a Node.js dependency and a
second config file to do what `cslug start` does in ~200 lines with `Bun.spawn`. On Railway it would also put a
second restart policy on top of Railway's own. `cslug start` handles exactly what cslug needs: role-aware
graceful shutdown, readiness only once `web` is listening, and restarts limited to children.

### 3. Separate services: one role per container (recommended for production at scale)

The same image, deployed several times with a different start command each. This is the most isolated option,
and each role scales independently.

## Railway

### A single service (MVP, staging)

Railway detects a Bun project and installs it; set the build and start commands on the service (or in
`railway.json`):

| Setting | Value |
|---|---|
| Build command | `bun cslug build` |
| Start command | `bun cslug migrate --force && bun cslug start` |
| Health check path | `/health/ready` |
| Restart policy | on failure |

One service runs web, worker and scheduler. Postgres and Redis are Railway services in the same project,
connected through `DATABASE_URL` and `REDIS_URL`.

### Several services (production)

Create three services from the **same repo**, sharing variables (Railway reference variables or a shared group).
Only the start command differs:

| Service | Start command | Public domain | Healthcheck |
|---|---|---|---|
| `app-web` | `bun cslug migrate --force && bun cslug serve` | yes | `/health/ready` |
| `app-worker` | `bun cslug queue:work` | no | — (`cslug queue:health` exits non-zero if stuck) |
| `app-scheduler` | `bun cslug schedule:work` | no | — |

Moving from one service to three is **a deployment change only**: no code changes, because every role reads
the same config.

### Deploys and `SIGTERM`

On each deploy the old container receives `SIGTERM`. cslug then:
1. stops accepting new requests and finishes in-flight ones (`http.shutdownTimeout`, default 10s);
2. tells workers to stop reading new jobs and lets running jobs finish (`queue.shutdownTimeout`, default 30s);
3. stops the scheduler after its current tick;
4. exits 0.

Set Railway's draining time on the service to at least the longest of these timeouts. A job that is cut off
anyway is not lost: its lease expires and another worker reclaims it (at-least-once; see
[guide 11](./11-queues-and-jobs.md#idempotent-handlers)).

## Development

`cslug dev` runs everything in one terminal: the processes of `cslug.config.ts` (model 2), each under `bun --watch`,
plus the asset watcher with HMR. `cslug dev --web` (or `--worker`, `--scheduler`) runs only some roles. You never
need two terminals or two instances in development.

## Choosing

| Situation | Model |
|---|---|
| Development | `cslug dev` |
| MVP / staging on one Railway service, I/O-bound jobs | `cslug start` (model 2) |
| Very small and memory-constrained | `cslug serve --with-worker --with-scheduler` (model 1) |
| Production with traffic, or CPU-heavy jobs | Separate services (model 3) |

## Build

cslug needs no container image of its own: any host that runs Bun builds and starts the app with two commands.

```bash
bun install --frozen-lockfile
bun cslug build          # Bun.build: islands, CSS, precompiled Vue render functions, manifest
```

Then the start command of each service (above): `bun cslug start`, or `serve` / `queue:work` / `schedule:work`
for separate services, after `bun cslug migrate --force`. Set `APP_ENV=production` in the environment. If your
platform wants an image, write the Dockerfile you need around these commands.

## Release steps

1. `cslug migrate --force` (advisory-locked, so it is safe if several services start at once).
2. Roll web, worker and scheduler (one service or three).
3. Graceful drain as described above.

## Requirements

- **Bun** ≥ 1.3.14
- **PostgreSQL** ≥ 15 (tested on 17)
- **Redis** ≥ 6.2 (the queue uses `XAUTOCLAIM`; tested on 8.0). Redis Cluster is not supported in v1.

## Health

| Endpoint / command | Checks |
|---|---|
| `GET /health/live` | Process up |
| `GET /health/ready` | Every registered check: Postgres and Redis reachable (and yours, guide 05); 503 when one fails |
| `cslug queue:health` | Worker heartbeat recent, oldest waiting job under a threshold (for worker-only services) |

## Observability

- JSON logs on stdout, one line per request and per job, carrying `requestId` / `jobId`, `userId` and the role
  (`web`, `worker`, `scheduler`); a job's lines also carry `originRequestId`, the request that started the work,
  so one search follows a request into its jobs. Secrets are redacted. `config/log.ts` sets the level and format
  (`LOG_LEVEL`, `LOG_FORMAT`) and more destinations (stderr, daily files with retention).
- With `@cslug/telemetry`: `/metrics` for Prometheus (loopback, a token or an address range), and traces,
  metrics and logs exported to an OpenTelemetry collector. See [guide 23](./23-observability.md).
- Error reporting hook: `this.app.resolve(ExceptionHandler).report((error, ctx) => sentry.captureException(error))`.
- Tracing: a request, the jobs it dispatches and their queries share one trace; log lines carry its `traceId`.

## Rotating APP_KEY

`APP_KEY` encrypts `encrypted()` columns and two-factor secrets, and signs URLs and magic links. To change it
(a leak, a departing admin, a schedule) without losing data or breaking links:

1. `cslug key:rotate --write` (or without `--write`, to print the values for your host's settings): a new
   `APP_KEY`, the old one first in `APP_PREVIOUS_KEYS`.
2. Set both on every process (web, worker, scheduler) and deploy. Old values still decrypt and old links still
   verify; everything new uses the new key.
3. `cslug db:reencrypt`: encrypted columns move to the new key (safe to run again).
4. Once links signed before the rotation have expired, remove the old key from `APP_PREVIOUS_KEYS`.

## Behind a load balancer or proxy

The platform's proxy terminates HTTPS and forwards requests, so the app sees the proxy's address. List it in
`http.trustedProxies` (exact addresses, or `'loopback'` when the proxy runs on the same machine): `X-Forwarded-For`
is then read for `request.ip()`, which throttling, the audit log and `@cslug/security`'s IP filter and per-IP limit
use. Without it, every visitor has the proxy's address.

`APP_URL` must be the public `https://` URL: absolute links in mail, signed URLs and `statefulApi` use it. With
`APP_ENV=production`, cookies are `Secure` and `securityHeaders()` sends HSTS.

## Production checklist

- `APP_ENV=production`, `APP_URL` with `https://`, `APP_KEY` set (`cslug key:generate`), `http.trustedProxies` set.
- `bun cslug build` ran, and `bun cslug migrate --force` runs before the new code serves traffic.
- Mail transport not `log`; Redis and Postgres reachable from every role.
- A worker runs (`cslug queue:health` from a cron or the platform's checks), and one scheduler.
- `/health/ready` is the platform's health check.
- `cslug about` shows the Bun and `@cslug/*` versions (they should all match).
