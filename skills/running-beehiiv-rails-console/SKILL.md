---
name: running-beehiiv-rails-console
description: "MUST be used when connecting to a beehiiv Rails console via Heroku to run diagnostic queries or debug data integrity. Covers tmux session pairing (how Claude attaches and sends commands), the five pry/Apiary/Searchkick gotchas that break console pastes, ClickHouse query safety (timeouts, ghost queries, SETTINGS clause), and the canonical flow for iterating on errors. Triggers on: rails console, heroku run rails c, apiary query, clickhouse query, peerdb, searchkick, staging console, production console, pry paste, tmux session, beehiiv-swarm, beehiiv-swarm-staging."
---

# Running beehiiv Rails Console

A shared playbook for when Michael and I need to run diagnostic Rails queries on a beehiiv environment — counting records, checking drift, testing a query before baking it into a job.

## When to use

- Scoping a data-integrity problem (how many records affected?)
- Querying Apiary (ClickHouse mirror) for analytics-scale aggregations without touching prod PG
- Testing a query interactively before shipping it as a rake task or job
- Investigating a production incident where "just tell me the count" is the answer

## Connecting to the console

Both environments run on Heroku. beehiiv uses Heroku's pipeline naming convention: **production is the default name, staging gets the `-staging` suffix.**

**Production:**

```bash
heroku run rails c -a beehiiv-swarm
```

**Staging:**

```bash
heroku run rails c -a beehiiv-swarm-staging
```

Both drop into a **pry-backed** Rails console (not IRB). Pry has its own parsing quirks — see pitfalls below.

Heroku one-off dynos take 30-60s to boot. They also have an idle timeout and will die if you walk away — which means any in-flight ClickHouse query may or may not get cancelled (see ClickHouse safety section below).

## Pairing via tmux (how we work together)

For multi-step work, Michael opens the console inside a **named tmux session** so I can attach and send commands directly. This beats copy/paste every time — I see the exact error, I write a fix, the fix lands without transcription.

**Michael-side setup:**

```bash
tmux new -s swarm-staging   # or swarm-production
# inside the session:
heroku run rails c -a beehiiv-swarm-staging
```

**Claude-side workflow:**

```bash
tmux list-sessions                                # find the session name
tmux capture-pane -t <session> -p -S -200         # read recent output (last 200 lines)
tmux load-buffer /tmp/script.rb                   # load a file into paste buffer
tmux paste-buffer -t <session>                    # paste the buffer
tmux send-keys -t <session> Enter                 # trigger evaluation
tmux send-keys -t <session> C-c                   # interrupt a hung query
```

**Always `sleep N` between paste and capture** — pry eval takes 2-10s depending on query size. A quick count might be 2s, a multi-phase script with ES aggs is 20-30s.

## Pry paste pitfalls

### 1. Pry evaluates line-by-line unless forced atomic

When you paste a multi-statement block, pry evaluates each line as it arrives. Intermediate variables get assigned but **later lines may see `nil`** for things earlier lines defined (especially when the paste is fast and the parser gets confused mid-block).

**Fix: wrap the whole script in `eval <<~'TAG' ... TAG`** — pry waits for the terminator before evaluating.

```ruby
eval <<~'SCRIPT'
  x = compute_something
  y = x.transform
  puts y
SCRIPT
```

**Use single quotes on the terminator** (`'SCRIPT'` not `"SCRIPT"`) to disable string interpolation inside the heredoc — so `#{}` in your code behaves as Ruby interpolation at eval time, not heredoc interpolation at paste time.

### 2. Leading-dot method chains break inside heredocs

Lines like `.select(` and `.group(` at the start of a line trick pry into thinking they're shell commands. Pry treats leading `.` as a shell-exec prefix. Errors look like `sh: 1: Syntax error: end of file unexpected` even though you're running Ruby.

**Fix: flatten the chain** — either on one line, or via intermediate variables:

```ruby
# BAD — leading dots break
rel = Model.where(...)
  .select(...)
  .group(...)

# GOOD — one line
rel = Model.where(...).select(...).group(...)

# ALSO GOOD — rebind
rel = Model.where(...)
rel = rel.select(...)
rel = rel.group(...)
```

### 3. Multi-line parentheses confuse pry's parser

`.select(\n  arg,\n  arg\n)` split across lines can make pry lose track of where the heredoc ends — then it treats later lines as separate statements.

**Fix: keep parens on a single line** (even if the line is long) or use block/hash syntax that's less ambiguous.

## beehiiv-specific query gotchas

### 4. Apiary multi-field `.group(...).count` doesn't return a Hash

On PG, `Model.group(:a, :b).count` returns `{ [a, b] => count }`. On Apiary (ClickHouse adapter), the same call returns an `ActiveRecord::Relation` — you can't call `.transform_keys` or any Hash method on it.

**Fix: use `.select(...).to_a` with explicit SQL aliases:**

```ruby
rows = Apiary::Post.final
  .select("publication_id",
          Arel.sql("toStartOfMonth(created_at) AS month"),
          Arel.sql("count(*) AS cnt"))
  .group(:publication_id, Arel.sql("toStartOfMonth(created_at)"))
  .to_a

rows.each { |r| puts [r.publication_id, r.month, r.cnt].inspect }
```

Flatten this onto one line when pasting (see pitfall 3).

### 5. PeerDB translates PG NULL to ClickHouse epoch

PostgreSQL `deleted_at IS NULL` (soft-delete alive) becomes ClickHouse `deleted_at = '1970-01-01 00:00:00'` (epoch). Filtering `where(deleted_at: nil)` matches **zero rows** in the Apiary mirror.

**Fix: filter by epoch:**

```ruby
Apiary::Post.final.where(deleted_at: Time.at(0).utc)   # alive rows
```

This applies to any nullable column in any PeerDB mirror — not just `deleted_at`.

### 6. `Apiary::Post.final` matters

`.final` is a ClickHouse-specific scope (via `ClickpipesBase`) that forces the engine to dedupe rows by primary key at query time. Without it, you may see duplicate rows from the `ReplacingMergeTree` engine's background merge lag.

**Rule: always chain `.final` on Apiary queries** unless you specifically want to see the raw mirror state.

### 7. Searchkick `Index#client` is protected

```ruby
Post.search_index.client.search(...)   # => NoMethodError: protected method 'client'
```

**Fix: use the module-level client:**

```ruby
Searchkick.client.search(index: Post.search_index.name, body: { ... })
```

`Searchkick.client` returns the underlying Elasticsearch client, which has the full ES API (`.search`, `.index`, `.delete`, `.indices.get_mapping`, etc.).

## Reading tmux output

Pry prefixes input lines with `[N] session:pry (main)>` and continuation lines with `[N] session:pry (main)*`. When scanning `tmux capture-pane` output for results:

- **Skip lines with `[N]` prefix** — those are echoed input, not output
- **Look for lines without the prefix** — those are actual stdout or the `=> value` return from a Ruby expression
- **Ruby return values** show as `=> ...` on their own line after the input finishes

Example:

```
[87] swarm@staging:pry (main)> Post.count
=> 35262                         <-- this is the result
[88] swarm@staging:pry (main)>
```

## Canonical flow for a new diagnostic

1. **Michael** opens a named tmux session with the Rails console for the target environment
2. **Claude** writes the script to `/tmp/name.rb`, wrapped in `eval <<~'TAG' ... TAG`
3. **Claude** flattens any leading-dot chains and multi-line parens
4. **Claude** pastes via `load-buffer` + `paste-buffer` + `send-keys Enter`
5. **Claude** waits (`sleep N`) then `capture-pane` to read output
6. **Iterate** on errors — pry will surprise you, ClickHouse has opinions, Searchkick has ghosts

Expect 2-3 iterations on any non-trivial query. That's normal. Each error teaches the environment's specific quirks.

## When NOT to use this

- **Writing a permanent job or rake task** — console is for _exploration_. Once a query works, port it into a proper file under `app/services/` or `lib/tasks/` and ship it via PR.
- **One-off counts you can answer via Apiary UI** — beehiiv has Metabase/similar dashboards for standard metrics. Console is for novel queries.
- **Anything mutating prod data** — never run destructive queries through this flow without a documented plan, dry-run output, and Michael's explicit sign-off.
