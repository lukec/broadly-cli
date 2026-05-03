# Reaction Event Format

The local voting sandbox stores votes as append-only `VoteEvent` JSON lines:

```text
votes/<vote-round-id>/reaction-events.jsonl
```

Statement reaction events record:

- `eventId`
- `eventKind`: `statement-reaction`
- `createdAt`
- `voteRoundId`
- `participantId`
- `statementId`
- `reaction`: `agree`, `disagree`, or `pass`
- `previousReaction`, when a participant changes an earlier vote

Initial-question response events record:

- `eventId`
- `eventKind`: `initial-question-response`
- `createdAt`
- `voteRoundId`
- `participantId`
- `questionId`
- `response`: `yes`, `no`, or `skip`
- `previousResponse`, when a participant changes an earlier answer

`reaction-state.json` is the derived latest state by participant and statement.
It also stores configured initial questions and the latest initial-question
responses by participant. It can always be rebuilt from the JSONL event stream
in a later implementation.

Exports are written with:

```bash
broadly vote export
```
