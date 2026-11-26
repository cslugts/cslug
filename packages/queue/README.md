# @cslug/queue

Jobs and workers on Redis Streams: retries with backoff, delays, priorities, unique jobs, after-commit dispatch,
queued listeners, the failed store and the `queue:*` commands; the scheduler (`routes/schedule.ts`). List
`QueueProvider` and `ScheduleProvider` in `bootstrap/providers.ts`.

```ts
await SendCheckinJob.dispatch({ bookingId }).delay('3d')
```

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 11](../../guides/11-queues-and-jobs.md), [guide 12](../../guides/12-scheduler.md).
