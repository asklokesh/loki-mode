# Queue operations: what happens when a worker dies

Written for the person on call when builds stop coming out.

## The short version

A build that vanished is recoverable. Run:

```bash
bash autonomy/queue-consumer.sh --reap
```

It requeues in-flight items whose worker died. It never touches a build that is
still running, and it never deletes anything.

## What the queue guarantees, and what it does not

| | redis backend | file backend |
|---|---|---|
| Delivery | at-least-once (default) | at-least-once |
| Crash leaves the item | in `<key>:processing` | in `processing/` |
| Automatic recovery | `--reap` | see below |
| Claim time recorded | `<key>:claims` hash | file mtime |

**A crashed worker does not lose the build.** It used to: the redis backend was
at-most-once (`LPOP`-then-run), so a worker killed between the pop and the
finish took the item with it and nothing anywhere recorded that it existed.
Proven against a real redis 8.6.3, then fixed with `LMOVE`, which pops and
records in-flight in one atomic step.

`LOKI_QUEUE_ACK=0` restores the old lossy behaviour if you are running a broker
that already guarantees delivery and do not want a second in-flight record.

## Recovering a stalled fleet

Symptom: items are queued, workers are up, and nothing completes.

```bash
# 1. What is stuck?
redis-cli -u "$LOKI_QUEUE_URL" LLEN loki-builds             # waiting
redis-cli -u "$LOKI_QUEUE_URL" LLEN loki-builds:processing  # claimed, in flight

# 2. Requeue anything whose worker is gone.
bash autonomy/queue-consumer.sh --reap
# -> reap: requeued 2, left 1 in flight (timeout 7200s)
```

The reaper reports what it did. "left 1 in flight" means one item's claim is
still inside the visibility timeout, so it is treated as a running build and not
touched.

### The timeout is the safety knob

`LOKI_QUEUE_VISIBILITY_SEC` (default 7200) is how long an item may be in flight
before the reaper assumes its worker died.

**It must exceed your longest legitimate build.** Set it too low and the reaper
requeues work that is still running, and the user gets the same build twice.
That is the only way this tool can hurt you, so it errs long by default.

### An item with no claim is reaped immediately

If a worker dies between claiming the item and stamping the claim time, the
item sits in `processing` with no entry in `<key>:claims`. The reaper treats
that as infinitely old, not infinitely young -- it is exactly the case that must
be recoverable, and erring the other way would strand the items this exists to
rescue.

## Running the reaper unattended

A CronJob is the intended shape. It is a separate mode rather than part of the
consume loop on purpose: a consumer that reaped on every poll would race its own
peers on a busy queue.

```yaml
schedule: "*/15 * * * *"
command: ["bash", "autonomy/queue-consumer.sh", "--reap"]
```

## What is NOT claimed

- **The file backend has no automatic reaper.** `--reap` is redis-only today; a
  crashed worker on the file backend leaves its item in `processing/` for a
  human to move back to `pending/`. The item is not lost, but nothing recovers
  it on its own.
- **No dead-letter queue.** An item that fails repeatedly is requeued
  repeatedly. There is no automatic give-up-and-park.
- **`LREM` clears every equal copy.** Two identical specs queued twice both
  clear on the first ack. Accepted deliberately: the alternative needs a
  per-item token from the producer, and the failure mode here is one duplicate
  re-drive rather than a lost build.
- **Only redis and file ship.** SQS, Pub/Sub, RabbitMQ and Kafka are
  bring-your-own: override `queue.command` with your own consumer.

## Check any of this yourself

```bash
bash tests/test-queue-at-least-once.sh    # 16 assertions; live half needs a broker
redis-server --port 6399 --save '' --appendonly no &
LOKI_TEST_REDIS_PORT=6399 bash tests/test-queue-at-least-once.sh
```

The live checks SKIP with a named reason when no broker is present rather than
passing on a mock. Both bugs found building this were invisible to a fake:
`redis-cli --no-raw` escapes the inner quotes of a JSON payload, which mangled
the item and made the ack a silent no-op. A green mock would have certified both
as working.
