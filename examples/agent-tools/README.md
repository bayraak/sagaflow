# agent-tools

MCP-style tools for an agent, on sagaflow. **Reads run, writes propose.**

```bash
bun test examples/agent-tools
```

An agent taking actions on a real system has the same problem a backend does, only louder: it
will retry, it will be interrupted, and somebody will ask afterwards what it did.

**What to look at**

- `proposeRefund` — a **write** tool. Every effect is an `action()` with an undo, so the whole
  proposal can be taken back; `idempotent: true` means the same proposal asked for twice is one
  proposal, however many times the agent retries.
- The point of no return is not in it. Sending the money lives in `settleRefund`, a **durable**
  saga that waits for a human with `waitForEvent` — for up to a week, holding nothing open while
  it waits.
- `listRuns` — a **read** tool. No saga, because reading changes nothing. It answers from
  `flow.inspect(runId)`: the run, its status and its trail, out of your own tables.

sagaflow does not plan, validate reasoning or manage context. It makes every action an agent
takes recorded, undoable, idempotent and announced once.
