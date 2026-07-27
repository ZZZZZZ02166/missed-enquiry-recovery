---
name: queues-redis
description: BullMQ and Redis for background work in the missed-call recovery flow — queue topology, delayed jobs for follow-up nudges, retry and backoff policy, idempotent workers, dead-letter handling, rate limiting outbound sends, repeatable maintenance jobs, graceful shutdown, and the Redis persistence and eviction settings that silently destroy scheduled work. Use when adding or changing a queue or worker, scheduling delayed or recurring work, debugging a job that ran twice or never ran, or configuring Redis in docker-compose or a hosting provider.
---

# Queues and Redis

Everything asynchronous in this product runs through BullMQ: the recovery SMS, LLM extraction on each
customer reply, the owner notification, follow-up nudges, and conversation expiry.

**Nothing with a side effect happens inside an HTTP request.** Webhooks validate, persist, enqueue,
return (see the `twilio` skill, §3).

---

## 1. Redis configuration — get this wrong and scheduled work vanishes

Two settings matter more than everything else in this file.

### Persistence must be on

BullMQ stores the entire queue in Redis, including delayed jobs (in a sorted set keyed by execution
time). A Redis instance without persistence loses **every pending and delayed job** on restart — silently.
No error, no dead letter. The follow-up nudges scheduled for tomorrow morning simply never fire.

```conf
appendonly yes
appendfsync everysec
```

Managed providers often offer a "cache" tier with persistence disabled and a "durable" tier with it on.
**Pick the durable one.** The cache tier is cheaper for a reason and that reason breaks this product.

### Eviction must be `noeviction`

```conf
maxmemory-policy noeviction
```

Managed Redis frequently defaults to `allkeys-lru` because the assumed workload is caching. Under memory
pressure that policy **evicts job data** — BullMQ then sees corrupt or missing keys and behaves
unpredictably. `noeviction` makes memory pressure a loud failure instead of a silent one, which is what
you want for a queue.

Verify both after any provider change:

```
redis-cli CONFIG GET appendonly maxmemory-policy
```

### ioredis connection options

BullMQ requires these; it throws or misbehaves otherwise:

```ts
new IORedis(url, {
  maxRetriesPerRequest: null,   // required — BullMQ manages its own retries
  enableReadyCheck: false,
});
```

Share one connection across queues where practical, but **workers need their own** — a blocking worker
connection can't also serve queue commands.

---

## 2. Topology

One NestJS codebase, two entrypoints (`CLAUDE.md`). `main.ts` only *produces* jobs; `worker.ts`
registers the processors. Same modules, same image, different start command.

| Queue | Job | Trigger |
|---|---|---|
| `recovery` | Send the first recovery SMS | Missed-call webhook |
| `inbound-message` | Extract fields, pick next question, send reply | Inbound SMS webhook |
| `notify-owner` | Owner lead SMS + magic link | Lead reaches QUALIFIED, or needsHuman is set |
| `followup` | Nudge a silent conversation; expire it | Scheduled with `delay` at conversation start |
| `maintenance` | Expiry sweep, Friday owner close-out nudge | Repeatable |

Keep queues narrow and named after the work, not the module. A queue per side effect makes rate limits,
retry policy and failure isolation independently tunable — one shared `default` queue makes all three
global.

---

## 3. Idempotency — `jobId` is not enough

BullMQ deduplicates on `jobId` **only while the job is still in the queue**. Once it completes and is
removed, the same `jobId` can be added again and will run again. It is a de-duplication convenience, not
a durable guarantee.

**Durable idempotency lives in Postgres**, via `webhook_events` unique `(provider, externalEventId)` and
state checks inside the processor:

```ts
// inside the processor, not the producer
if (conversation.recoverySentAt) return;   // already done, exit clean
```

Every processor must be safe to run twice. Assume it will be: workers get killed mid-job, jobs stall and
get retried, deploys restart processes.

Still set a meaningful `jobId` (`recovery:${callSid}`) — it collapses the common duplicate-webhook case
cheaply, before the processor even starts.

---

## 4. Retry policy

```ts
{
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },   // 2s, 4s, 8s, 16s, 32s
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800 },                    // keep failures a week for inspection
}
```

`removeOnComplete` is not optional — without it Redis grows without bound until it hits the memory limit,
at which point §1's eviction policy is the only thing standing between you and data loss.

**Do not retry** these — they will fail identically every time and each attempt costs money:

| Condition | Action |
|---|---|
| Twilio 21610 (unsubscribed) | Write suppression, exit clean |
| Twilio 21211 / 21614 (invalid or landline `To`) | Write suppression, exit clean |
| Twilio 21408 (geo permissions) | Fail loudly and alert — configuration bug, not transient |
| Validation / schema errors | Fail immediately, no attempts |

Use BullMQ's `UnrecoverableError` to skip remaining attempts:

```ts
throw new UnrecoverableError(`suppressed: ${code}`);
```

The distinction matters: retrying a permanent failure five times with exponential backoff turns one
wasted send into five, and hides the real cause behind a stack of timeouts.

---

## 5. Delayed and repeatable work

**Delayed** — the follow-up nudge and conversation expiry:

```ts
await followupQueue.add('nudge', { conversationId }, { delay: ms, jobId: `nudge:${conversationId}` });
```

Compute the delay in the **business's** timezone, never the server's (`CLAUDE.md` rule 12). A nudge must
not arrive at 3am. If the computed time falls outside business hours, push it to the next opening.

Cancel the nudge when the customer replies — `job.remove()` by `jobId`, and check state in the processor
anyway, because the removal races with execution.

**Repeatable** — maintenance:

```ts
{ repeat: { pattern: '0 17 * * 5', tz: 'Australia/Melbourne' } }
```

BullMQ's `tz` handles DST correctly; a raw millisecond interval does not. Repeatable jobs persist in
Redis, so **changing the pattern leaves the old schedule in place** — remove the old repeatable job
explicitly on deploy, or you will have two.

---

## 6. Rate limiting and concurrency

```ts
new Worker('recovery', processor, {
  connection,
  concurrency: 5,
  limiter: { max: 10, duration: 1000 },   // protects the provider, not us
});
```

Twilio throttles per number; bursting produces queued messages and out-of-order delivery, which reads as
a broken conversation to the customer. Rate limit outbound send workers.

Keep `concurrency` low for LLM-calling processors — they're slow and the failure mode under load is cost,
not latency.

**Never block the event loop in a processor.** BullMQ detects stalled jobs by missed heartbeats; a
synchronous blocking call gets the job marked stalled and re-run *while the first run is still going* —
the most confusing duplicate-execution bug in the stack.

---

## 7. Failure handling and observability

- **Dead letter is the failed set.** With `removeOnFail: { age: 604800 }` a week of failures stays
  inspectable. Add an endpoint or script to list and retry them; don't inspect Redis by hand.
- **Alert on failure rate and on queue depth**, not on individual failures. A single failed send is
  normal; a rising `failed` count or a `waiting` backlog means something systemic.
- `QueueEvents` gives `completed` / `failed` / `stalled` streams for metrics.
- Log `jobId`, queue name and attempt number on every processor entry and exit. Without the attempt
  number, retries are indistinguishable from duplicates in the logs.

---

## 8. Graceful shutdown

```ts
process.on('SIGTERM', async () => {
  await worker.close();   // stops taking new jobs, finishes in-flight
  await connection.quit();
});
```

Without this, a deploy kills workers mid-job. Those jobs stall and re-run — safe only because §3 made
every processor idempotent. Do both anyway.

---

## 9. Testing

- **Unit-test processors as plain functions.** They take `job.data` and call injected services; there's
  no reason to involve Redis to test the logic.
- **Integration tests use a real Redis** (the docker-compose one) with a per-test queue name prefix, and
  `drain()`/`obliterate()` between tests. In-memory Redis fakes diverge from real behaviour on exactly
  the things worth testing — delayed sets, stalled detection, atomicity.
- **Test the duplicate case explicitly.** Run the same job twice and assert one SMS, one lead. This is
  the invariant most likely to regress and the one with a real-money consequence.
- **Test the restart case.** Schedule a delayed job, restart Redis, assert it still fires. That test is
  what proves §1's persistence config is actually applied — the only alternative is discovering it in
  production when a week of nudges quietly didn't send.
