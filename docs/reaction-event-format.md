# Reaction Event Format

The local voting sandbox stores votes as append-only `ReactionEvent` JSON lines:

```text
votes/<vote-round-id>/reaction-events.jsonl
```

Each event records:

- `eventId`
- `createdAt`
- `voteRoundId`
- `participantId`
- `statementId`
- `reaction`: `agree`, `disagree`, or `pass`
- `previousReaction`, when a participant changes an earlier vote

`reaction-state.json` is the derived latest state by participant and statement.
It can always be rebuilt from the JSONL event stream in a later implementation.

Exports are written with:

```bash
broadly vote export
```

