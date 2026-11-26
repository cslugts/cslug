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
DB updates), which describes all of Albastr's MVP jobs.

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

```json
// railway.json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE" },
  "deploy": {
    "startCommand": "bun cslug migrate --force && bun cslug start",
    "healthcheckPath": "/health/ready",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

One service runs web, worker and scheduler. Postgres and Redis are Railway services in the same project,
connected through `DATABASE_URL` and `REDIS_URL`.

### Several services (production)

Create three services from the **same repo**, sharing variables (Railway reference variables or a shared group).
Only the start command differs:

| Service | Start command | Public domain | Healthcheck |
|---|---|---|---|
| `albastr-web` | `bun cslug migrate --force && bun cslug serve` | yes | `/health/ready` |
| `albastr-worker` | `bun cslug queue:work` | no | — (`cslug queue:health` exits non-zero if stuck) |
| `albastr-scheduler` | `bun cslug schedule:work` | no | — |

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

`cslug dev` already runs everything in one terminal (web with `--hot`, asset watcher, worker, scheduler), using
model 1. Use `cslug dev --isolated` to switch to model 2 when you want to reproduce production behaviour. You
never need two terminals or two instances in development.

## Choosing

| Situation | Model |
|---|---|
| Development | `cslug dev` (model 1) |
| MVP / staging on one Railway service, I/O-bound jobs | `cslug start` (model 2) |
| Very small and memory-constrained | `cslug serve --with-worker --with-scheduler` (model 1) |
| Production with traffic, or CPU-heavy jobs | Separate services (model 3) |

## Build

```dockerfile
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun cslug build                     # Bun.build: islands, CSS, precompiled Vue render functions, manifest

FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=build /app /app
ENV APP_ENV=production
EXPOSE 3000
CMD ["bun", "@cslug/core", "start"]           # overridden per service by the start command
```

## Release steps

1. `cslug migrate --force` (advisory-locked, so it is safe if several services start at once).
2. Roll web, worker and scheduler (one service or three).
3. Graceful drain as described above.

## Health

| Endpoint / command | Checks |
|---|---|
| `GET /health/live` | Process up |
| `GET /health/ready` | Postgres and Redis reachable, migrations up to date; under `cslug start`, also that the worker and scheduler children are running |
| `cslug queue:health` | Worker heartbeat recent, oldest waiting job under a threshold (for worker-only services) |

## Observability

- JSON logs on stdout, one line per request and per job, carrying `requestId` / `jobId`, `userId` and the role;
  secrets redacted.
- `/metrics` (behind `auth('token')`): request counts and latencies, jobs by state, queue lag, DB pool usage.
- Error reporting hook: `this.app.resolve(ExceptionHandler).report((error, ctx) => sentry.captureException(error))`.
- OpenTelemetry tracing: optional.

## Production checklist

`cslug about --production` checks: `APP_KEY` set, debug off, HTTPS URL, session cookie `Secure`, mail transport
not `log`, payments driver not `fake`, queue worker reachable, scheduler heartbeat within 2 minutes, migrations
current.
