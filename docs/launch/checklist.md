# Launch checklist

The order matters more than the list. Everything below assumes the post in
[`post.md`](./post.md) is the copy, and that the README is the landing page — there is no site,
and there does not need to be one.

## Before anything is posted

Nothing here is optional. A launch that sends people to a broken quickstart is worse than no
launch, because the second look never happens.

- [ ] `bun run typecheck` — clean, including the examples project
- [ ] `bun test` — green
- [ ] `bun run test:workerd` — green against real workerd, D1, Queues and Workflows
- [ ] `bun run test:examples` and `bun run test:example-worker` — green; the examples are executed
      in CI, not merely type-checked, so "working" is a claim CI makes
- [ ] `bun run lint` — 0
- [ ] `bun run fmt:check` — clean
- [ ] `npm pack --dry-run` — lists `dist/`, `README.md`, `SKILL.md`, `LICENSE`, `CHANGELOG.md` and
      nothing else; **zero entries under `dependencies`**
- [ ] `bunx sagaflow schema` prints the DDL, and `--dialect d1` and `--tables …` do what they say.
      The bin is part of the published surface now, so a broken one is a broken release.
- [ ] The README's first example is the one the test suite compiles and runs. If they have drifted,
      the README is wrong.
- [ ] Every link in the README, `SKILL.md`, `llms.txt` and `docs/` resolves on the default branch —
      including the ones to test files, which are part of the guarantees table's credibility
- [ ] `CHANGELOG.md` names the version and what closed in it

## Publish

Order, because each step is the previous one's proof.

1. [ ] Tag and push `v0.1.0` on the default branch; the CI badge in the README must be green on
       that commit before anything else happens
2. [ ] `npm publish` — the package is scoped (`@bayraak/sagaflow`), so `publishConfig.access` must
       be `public` or the publish silently becomes private
3. [ ] `npm view @bayraak/sagaflow` — confirm the version, the files list and the empty dependency
       set from the registry rather than from the repository
4. [ ] In a scratch directory: `bun add @bayraak/sagaflow`, paste the six-line example, run it,
       then `bunx sagaflow schema` from the same directory. **This is the only check that proves
       the published artifact works**, and it has caught more broken releases than every gate
       above it
5. [ ] Confirm the npm badge in the README resolves to the published version
6. [ ] `bunx degit bayraak/sagaflow/examples/cloudflare-worker` into a scratch directory and run
       `bun run dev` — the template is quoted in two of the channels below and has to work with no
       account

## Channels, in order

Each one is at least a day after the one before it, unless something goes wrong — in which case
the order is: stop, fix, and let the fix sit before continuing. The order runs from the audience
most likely to read carefully to the audience most likely to arrive in volume.

### 1. Cloudflare Discord, `#workflows`

**First, deliberately.** The smallest and most expert audience: people who already run Workflows
and will find the sharp edges immediately. If anything in the Cloudflare story is wrong, this is
where it costs the least to learn it. Lead with the substrate, not the library.

### 2. r/Cloudflare

Same pitch, wider audience, a day later once the Discord thread has had time to produce
corrections. Lead with the copyable template.

### 3. Show HN

The volume moment, and the one that cannot be repeated. Post only after the two Cloudflare
channels have gone quiet and any correction from them has landed on the default branch.

Practical notes: post on a weekday morning, US Eastern; be at a keyboard for the following four
hours, because the first hour of comments decides the thread; answer the "why not Temporal / DBOS
/ Cloudflare's own rollbacks" questions with the structural argument and never with a claim about
anybody's maturity. If a comment finds a real gap, say so in the thread and open an issue in the
same reply.

### 4. Hono and tRPC communities

A different pitch — [`integrations.md`](../integrations.md), one middleware, every mutation
recorded — for people who do not care about Cloudflare at all. Their objection is "why not just
try/catch", which is the right objection and has an honest answer in
[`positioning.md`](../positioning.md).

### 5. awesome-cloudflare PR

After the traffic, not before: a list entry for something with no stars and no discussion is a
harder review than one with both.

### 6. Commerce and Medusa forums, where genuinely on topic

Last, smallest, and only where somebody is actually asking. Lead with
[`migrating-from-medusa.md`](../migrating-from-medusa.md), which is useful to people who are
staying.

## Rules for every channel

- **Structural arguments only.** Compare on the object of design and on runtime posture. Never on
  anybody's release stage, version number or funding. Those arguments erode, and the person who
  made them looks worse than the project they were made about.
- **DBOS is named with respect**, as the nearest neighbour, with what it does better said out loud.
- **Compensation is not claimed as a differentiator.** Cloudflare, Vercel, Effect and Medusa all
  have it. The specification is what differs.
- **The non-goals go in the post, not in the replies.** A limitation someone discovers is a
  problem; a limitation they were told about is a boundary.
- **Name the real competitor** — hand-rolled `try`/`catch` and fire-and-forget events — rather than
  pretending it is a platform.
- **during.day is the production user**, named as such: an application where every mutation is a
  run.

## After

- [ ] Every issue and comment from launch week triaged within 24 hours, including the dismissive
      ones — those are often the shortest route to a real gap
- [ ] Anything the threads got wrong about the docs fixed in the docs, not just in the reply
- [ ] The questions asked more than twice become README FAQ entries or a docs page
- [ ] Roadmap updated in public if launch changed the order. Resumable inline runs (0.3) is the
      first post-0.1 item and the answer to the most likely recurring question
