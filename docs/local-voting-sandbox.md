# Local Voting Sandbox

The voting sandbox is a local reference implementation for the open reaction
contracts. It is not production civic infrastructure.

Intentional limits:

- no accounts
- no email
- no CRM
- no hosted anti-abuse system
- no production moderation console
- no participant clustering or full Pol.is math yet

Basic workflow:

```bash
broadly statements review --accept <statement-id> --export-accepted
broadly vote init --statements statements/<statement-run-id>/statement-bank.json
broadly vote web
broadly vote analyze
broadly vote report
```

Initial questions can be configured in `broadly.yaml`:

```yaml
voting:
  initialQuestions:
    - questionId: works-in-government
      questionText: I work in government.
      responseKind: yes-no-skip
```

Each local participant must answer `yes`, `no`, or `skip` for every initial
question before the sandbox shows statement voting. The local web UI fixes the
participant id from the URL, hides answered initial questions, and shows one
unanswered statement at a time.

For no-browser smoke testing, deterministic synthetic votes can be added with:

```bash
broadly vote seed --participants 6
```
