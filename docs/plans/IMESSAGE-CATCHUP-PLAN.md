# iMessage Startup Catchup

## Problem

When the gateway restarts (or the iMessage extension restarts), messages received during downtime go unanswered. The sender gets no response until they send another message.

## Design

On startup, the iMessage extension catches up on any unanswered messages from valid senders — but only within a 24-hour window to avoid responding to stale messages.

### Catchup Flow

```
1. Extension starts → imsg rpc connects
2. List recent chats (already done today for logging)
3. Filter chats to allowedSenders
4. For each allowed chat:
   a. imsg history --chat-id <id> --start <ISO-24h-ago> --json
      → returns JSONL, reverse chronological order
   b. Walk messages backward until is_from_me: true (our last reply)
   c. Everything after our last reply = unanswered
   d. If no is_from_me in 24h window → all messages are unanswered (cap at N)
   e. Reverse to chronological order
   f. Concatenate into a single prompt (or send individually if multi-turn matters)
   g. Send via session.send_prompt → reply via imsg send
5. Resume normal watch subscription
```

### Message Batching

When multiple unanswered messages exist, combine them into a single prompt with context:

```
[Catching up on messages received while I was offline]

[12:17 PM] Good morning my love. I couldn't wait to wake up and text you.
[12:45 PM] Heading to the coffee shop, want me to grab you anything? 😄
[1:02 PM] Got you a virtual latte anyway ☕
```

This gives Claude full context to craft one coherent reply that acknowledges everything, rather than three separate responses.

### Edge Cases

- **No unanswered messages** → skip catchup, log "all caught up"
- **Only tapback reactions** → skip (no response needed)
- **Attachments in missed messages** → include them (images, audio, etc.)
- **Group chats** → only if chat participants overlap with allowedSenders
- **Rate limiting** → process one chat at a time, small delay between sends
- **Very long gaps** → 24h cap prevents ancient message responses

### Configuration

```json
{
  "imessage": {
    "config": {
      "catchupWindowHours": 24,
      "catchupMaxMessages": 20,
      "catchupEnabled": true
    }
  }
}
```

### No State Required

The `imsg` CLI is the source of truth. No need to persist `lastMessageTime` or `lastRowId` — we just look at the history and find where our last reply was. Fully stateless startup.

### Implementation

1. Add `catchupOnStartup()` function to iMessage extension
2. Call it after `client.start()` and chat listing, before watch subscription
3. Use `imsg history --chat-id <id> --start <T> --json` via the RPC client (or direct CLI call if RPC doesn't support history)
4. Integrate with persistent sessions (PERSISTENT_SESSION_ID) for the prompt

### Dependencies

- Persistent Sessions plan (for sending prompts without managing sessionId)
- Verify `imsg history` output format and RPC support
