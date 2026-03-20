# Federated Memory — Gateway-to-Gateway Protocol

> **Status**: Draft
> **Created**: 2026-03-20
> **Authors**: Michael & Claudia

## Overview

Anima runs on multiple machines — Anima Sedes (always-on server) and Vesuvius (Michael's MacBook). Today, each instance has its own memory database and no awareness of the other. This plan describes how to unify memory across instances so Claudia is the same Claudia everywhere.

## Design Principles

1. **Git is the sync layer for documents.** `~/memory` is already a git repo pushed to a private GitHub repo. We don't build a sync engine — we use git.
2. **Transcripts stay local.** Full conversation transcripts (tool calls, raw content blocks) are large and only needed on demand. They live in the local SQLite DB.
3. **G2G is for transcript relay.** The gateway-to-gateway protocol starts minimal — its primary job is fetching transcripts that live on a remote node.
4. **Don't over-engineer.** Two nodes, single user, Tailscale networking. No CRDTs, no consensus, no distributed database.

## Architecture

```
Vesuvius (laptop)                    GitHub                     Anima Sedes (server)
                                  ~/memory repo
Chat happens                          │
  → Libby processes                   │
  → writes to ~/memory/               │
  → git commit + push ───────────────►│
                                      │◄─────────── periodic git pull
                                      │             Libby sees new files
                                      │             indexes in FTS5
                                      │
                        (and vice versa)

                    ┌──── Tailscale ────┐
                    │                   │
              ┌─────┴─────┐      ┌─────┴─────┐
              │ Gateway    │◄────►│ Gateway    │
              │ :30086     │ G2G  │ :30086     │
              │ (vesuvius) │ WS   │ (anima-    │
              │            │      │  sedes)    │
              └────────────┘      └────────────┘
```

### What Syncs via Git

| Content       | Location                  | Sync Method   | Conflict Strategy            |
| ------------- | ------------------------- | ------------- | ---------------------------- |
| Episodes      | `~/memory/episodes/`      | git push/pull | Append-only, no conflicts    |
| Milestones    | `~/memory/milestones/`    | git push/pull | Append-only, no conflicts    |
| Relationships | `~/memory/relationships/` | git push/pull | Last-write-wins (rare edits) |
| Projects      | `~/memory/projects/`      | git push/pull | Last-write-wins              |
| Insights      | `~/memory/insights/`      | git push/pull | Last-write-wins              |
| Core facts    | `~/memory/core/`          | git push/pull | Last-write-wins              |
| Personas      | `~/memory/personas/`      | git push/pull | Last-write-wins              |

### What Stays Local

| Content               | Location                          | Why                            |
| --------------------- | --------------------------------- | ------------------------------ |
| Transcript entries    | `memory_transcript_entries` table | Large, rarely needed remotely  |
| File ingestion state  | `memory_file_states` table        | Node-specific bookkeeping      |
| Conversation metadata | `memory_conversations` table      | Derived from local transcripts |

### What Travels via G2G

| Content          | Method                      | When                                    |
| ---------------- | --------------------------- | --------------------------------------- |
| Transcript fetch | `federation.get_transcript` | On demand (UI click, memory-mcp recall) |
| Peer health      | `federation.status`         | Heartbeat / connection check            |

## Node Identity

Each node is identified by its hostname (`anima-sedes`, `vesuvius`). Origin can be inferred from episode files — the `**Project:**` line contains the cwd path (`/Users/michael/...` = Vesuvius, `/Users/claudia/...` = Anima Sedes).

Future: add explicit `**Node:** anima-sedes` to episode frontmatter for clarity. Not blocking — the path heuristic works today and conversation ID collisions are vanishingly unlikely (would require identical start timestamps AND overlapping integer IDs).

Episode filenames: `YYYY-MM-DD-HHMM-{conversationId}.md` — the conversation ID is embedded in the filename, making transcript lookups straightforward.

## Implementation Plan

### Phase 1: Git Automation (memory extension)

Add git operations to the memory extension lifecycle:

1. **On startup**: `git pull` in `~/memory` to catch up
2. **After Libby processes a batch**: `git add -A && git commit -m "libby: {n} conversations processed" && git push`
3. **Periodic pull**: Every 5 minutes (configurable), `git pull` and re-index any new/changed files
4. **On file change detection**: After pull brings new files, trigger `documentIngest()` to update FTS5 index

Configuration in `~/.anima/anima.json`:

```json
{
  "memory": {
    "config": {
      "git": {
        "enabled": true,
        "pullIntervalMs": 300000,
        "autoPush": true,
        "remote": "origin",
        "branch": "main"
      }
    }
  }
}
```

**Key files to modify:**

- `extensions/memory/src/index.ts` — Add git sync to lifecycle (startup, post-process, periodic)
- `extensions/memory/src/git.ts` — New file: git operations (pull, commit, push, status)
- `extensions/memory/src/document-ingest.ts` — Trigger re-index after git pull brings new files

### Phase 2: Federation Extension (G2G WebSocket)

New extension: `extensions/federation/`

**Peer configuration** in `~/.anima/anima.json`:

```json
{
  "federation": {
    "enabled": true,
    "config": {
      "nodeId": "anima-sedes",
      "peers": [
        {
          "nodeId": "vesuvius",
          "address": "vesuvius.tail-scale-domain:30086"
        }
      ],
      "reconnectIntervalMs": 30000
    }
  }
}
```

**Methods:**
| Method | Description |
|--------|-------------|
| `federation.status` | List peers, connection state, last sync time |
| `federation.get_transcript` | Fetch transcript from peer by conversation ID |
| `federation.peers` | List configured peers and their online/offline status |

**Connection model:**

- On startup, connect to each peer's `/ws` endpoint via WebSocket
- Authenticate via shared secret or Tailscale identity (TBD)
- Reconnect on disconnect with backoff
- A peer gateway is just another WebSocket client — the hub architecture means no special handling needed

**Transcript relay flow:**

```
1. User/MCP requests transcript for conversation 78591
2. memory extension checks local DB → not found
3. memory extension calls ctx.call("federation.get_transcript", { conversationId: 78591 })
4. federation extension routes to the peer that has it
5. peer's memory extension serves it from local DB
6. response relayed back
7. (optional) cache transcript locally for future requests
```

### Phase 3: Smart Transcript Routing

Enhance `memory.get_transcript` to be federation-aware:

1. Check local `memory_transcript_entries` — serve if found
2. Parse the episode file to determine origin (cwd path or future `Node:` field)
3. Call `federation.get_transcript` on the origin peer
4. Cache result locally in `memory_transcript_entries` with a `source_node` column

Add `source_node` column to `memory_conversations` table for explicit tracking.

### Phase 4: Enrichments (Future)

- **Node field in episodes**: Add `**Node:** {nodeId}` to Libby's episode template
- **Cross-node search**: `memory.search` that also queries peers for transcript matches
- **Conversation list merge**: UI shows conversations from all nodes with origin badges
- **Selective transcript sync**: Background sync of "important" transcripts (starred, referenced)

## Non-Goals (For Now)

- **Session sync**: Live sessions stay local. No need to replicate active Claude SDK sessions.
- **Real-time event fanout**: Events (typing indicators, streaming deltas) don't cross gateways.
- **Multi-user**: This is a personal system. One user, multiple devices.
- **Database replication**: SQLite stays local. Git syncs the documents. G2G fills gaps on demand.

## Open Questions

1. **Authentication**: Tailscale identity (machine name) should be sufficient for now. Do we need anything else?
2. **Transcript caching**: Cache remotely-fetched transcripts forever, or evict after some period?
3. **Git conflict handling**: For mutable files (facts, relationships), `git pull --rebase` should handle most cases. What if there's a real conflict? Auto-resolve with last-write-wins, or flag for review?
4. **Push triggers**: Should git push happen immediately after Libby processes, or batch on a timer?
