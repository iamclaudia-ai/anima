---
name: provisioning-neon-projects
description: "MUST be used when creating a new Neon project, branch, or compute endpoint, and when investigating, auditing, or explaining a Neon bill. Neon bills CU-hours by wall-clock time the compute is AWAKE, not by work done, so a near-idle database can cost 50x what the app server costs. Covers safe creation defaults (pin to the smallest CU first, scale up once load is understood), auditing why a compute stopped suspending, and the known scale-to-zero blockers (short-interval pollers, logical replication slots from Electric SQL / Debezium / CDC, long-lived pools). Triggers on: create neon project, new neon database, neon branch, neon endpoint, neon bill, neon invoice, neon cost, CU-hours, compute hours, why is my database bill so high, scale to zero, autoscaling limits, neon compute never suspends, neon usage, audit neon, provision postgres, set up database."
---

# Provisioning Neon Projects

Use this skill when spinning up any new Neon project/branch, or when a Neon bill
needs explaining. **Default to the smallest compute and scale up on evidence.**

## The one thing to internalize

**A CU-hour bills wall-clock time the compute is awake, regardless of load.**

This is the opposite of how Railway, Fly, and most app hosts bill. A service can
use 0.5% of a CPU and still generate a full month of CU-hours — because the meter
runs on _being awake_, not on _doing work_. Neon suspends only after **5 minutes
with no activity**. Anything that touches the database more often than that pins
the meter at 100%, forever, silently.

Observed 2026-09: a ~2,000-player async game cost **$1.28/mo on Railway** and
**$73.55/mo on Neon** for the same workload. Two computes had simply stopped
sleeping — one to a 5-second task-runner tick, one to an Electric SQL slot.

## Creation checklist

When creating a project or endpoint, do all of these before writing any app code:

1. **Pin `min_cu = max_cu = 0.25`.** The console default max is often **8 CU** —
   an always-on 8 CU endpoint is ~$630/mo. Pin it flat, then raise deliberately
   once you have load numbers.
2. **Use local Postgres for exploration.** Anything WIP, spike, or "just testing
   a sync engine" belongs in Docker, not a hosted branch that quietly bills.
3. **Delete dev branches when done**, don't just stop using them. An idle branch
   still has an endpoint that anything can wake.
4. **Set a spend alert** in the Neon console.
5. **Record the endpoint id** in the project's notes so an audit is one command.

Raise the CU only when a real workload demands it — a bulk import, a backfill,
a rebuild — and **drop it back afterwards**. Migration weekends are the
legitimate reason to see 4–8 CU; steady state almost never is.

## What blocks scale-to-zero

Any of these means the compute never sleeps and you pay 744 hours/month:

- **A poller with an interval under 5 minutes.** A task-runner tick, a queue
  drain, a cron loop, a health check that hits the DB. Even a query that matches
  zero rows counts as activity.
- **A logical replication slot** — Electric SQL, Debezium, any CDC pipeline.
  These hold a persistent WAL-streaming connection by design; they are
  structurally incompatible with scale-to-zero. An **orphaned** slot
  (`active = false`) is worse: the app is long gone and it still retains WAL.
- **A connection pool that keeps backends open** across idle periods.
- **`pg_cron` jobs** on a short schedule.

If the app genuinely needs to be always-on, that is a legitimate choice — but
then the CU cap is the only cost control you have, so set it low.

## Auditing a bill

`neonctl` is authenticated already. `neonctl api <path>` is a raw authenticated
passthrough — use it, the CLI does not surface most of this.

```bash
# 1. Find the projects (they usually live under an ORG, not the personal account)
neonctl orgs list
neonctl projects list --org-id <org-id>

# 2. Every endpoint's size and whether it is awake right now.
#    started_at with no suspended_at = it has been awake since that moment.
neonctl api "/projects/<project-id>/endpoints" \
  | jq -r '.endpoints[] | "\(.id) branch=\(.branch_slug) cu=\(.autoscaling_limit_min_cu)-\(.autoscaling_limit_max_cu) state=\(.current_state) started=\(.started_at // "-") suspended=\(.suspended_at // "-") last_active=\(.last_active)"'

# 3. THE MONEY SHOT — daily suspend counts. A healthy endpoint suspends
#    dozens-to-hundreds of times a day. The day the count drops to zero is
#    the day something started polling. Correlate it with a deploy.
neonctl api "/projects/<project-id>/operations?limit=1000" \
  | jq -r '.operations[] | select(.action=="start_compute" or .action=="suspend_compute") | "\(.created_at[0:10]) \(.action) \(.endpoint_id)"' \
  | sort | uniq -c
```

`/consumption_history/*` is **Scale-plan only** and returns an error on lower
plans. The operations log above answers the same question for free.

Inside the database, find what is holding it open:

```sql
select slot_name, plugin, slot_type, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as wal_retained
from pg_replication_slots;              -- electric_slot_*, debezium_*, etc.

select pubname from pg_publication;      -- leftover CDC publications

select application_name, backend_type, state, client_addr::text
from pg_stat_activity;                   -- who is actually connected
```

Note: `client_addr` is always a Neon-internal `10.x` address — external clients
arrive via Neon's proxy, so the IP never identifies the caller. Use
`application_name` and connection _count_ instead.

## Fixing it

```bash
# Cap or pin an endpoint (takes effect on next compute restart)
neonctl api "/projects/<project-id>/endpoints/<endpoint-id>" -X PATCH \
  -F endpoint.autoscaling_limit_min_cu=0.25 \
  -F endpoint.autoscaling_limit_max_cu=0.25

# Force the new size to apply now AND stop the meter immediately
neonctl api "/projects/<project-id>/endpoints/<endpoint-id>/suspend" -X POST
```

Two gotchas:

- A PATCH schedules an apply operation; an immediate `suspend` is rejected with
  _"project already has running conflicting operations"_. Wait ~30s and retry.
- **If it wakes straight back up, something is still connected.** That is the
  finding, not a failure. Go look at `pg_stat_activity`.

Dropping an orphaned CDC slot (only once the pipeline is genuinely retired —
the consumer loses its sync position and must resnapshot):

```sql
select pg_drop_replication_slot('electric_slot_default');
drop publication if exists electric_publication_default;
```

## Estimating CU without the consumption API

`max_connections` tracks compute size, so it is a usable proxy:

| CU   | max_connections |
| ---- | --------------- |
| 0.25 | 112             |
| 0.5  | 225             |
| 1    | 450             |
| 2    | 901             |

```sql
select name, setting from pg_settings
where name in ('max_connections','shared_buffers');
```

Then: `CU-hours ≈ hours_awake × CU`. Cross-check against the invoice total —
a flat `min=max` endpoint is exact (`hours × CU`), so solve for the autoscaled
ones by subtraction.

## Notes

- Pinning CU does **not** affect availability, background workers, or job
  correctness — it only changes vCPU/RAM. The one thing that scales with it is
  `max_connections`; check current usage against the table above before pinning.
- Raising a poller's interval usually does **not** fix the bill. If the interval
  is still under 5 minutes, the compute still never sleeps. The fix is either
  event-driven wakeups (an idempotent _delayed_ kick preserves any coalescing
  window a poll interval was providing) or accepting always-on and capping CU.
- Before blaming the app, check whether the expensive endpoint is even the one
  you think. Bills are account-wide, and a forgotten WIP project can be half of it.
