# NEXT Demo Workflow

Use this when you want to manually inspect the open-contract features from
`NEXT.md` without spending money on model calls.

Run:

```bash
npm run demo:next
```

The script resets an ignored project at:

```text
projects/open-contracts-demo/
```

It runs the completed NEXT workflow:

1. build the CLI
2. create a synthetic report bundle and supporting analysis artifacts
3. generate report-derived statements
4. accept the generated statements and export `accepted-statements.json`
5. run statement QA
6. initialize a local voting round with ordered initial questions
7. seed synthetic initial-question answers and statement votes
8. analyze, export, and attach vote results to the report
9. attest report and statement artifacts
10. verify hashes
11. build a static report site

The demo config includes the initial question:

```text
I work in the government.
```

The script prints the generated artifact paths. The most useful files to inspect
are:

```text
projects/open-contracts-demo/statements/<statement-run-id>/statement-bank.json
projects/open-contracts-demo/statements/<statement-run-id>/accepted-statements.json
projects/open-contracts-demo/statements/<statement-run-id>/qa/<qa-run-id>/scorecard.json
projects/open-contracts-demo/votes/<vote-round-id>/reaction-events.jsonl
projects/open-contracts-demo/votes/<vote-round-id>/exports/initial-question-results.csv
projects/open-contracts-demo/votes/<vote-round-id>/exports/statement-results.csv
projects/open-contracts-demo/reports/demo-run/vote-summary.json
projects/open-contracts-demo/attestations/reports/demo-run.attestation.json
projects/open-contracts-demo/reports/demo-run/site/index.html
```

Optional browser checks:

```bash
node packages/cli/dist/index.js vote web --project projects/open-contracts-demo --port 4320
```

Open `http://127.0.0.1:4320` and confirm the initial questions appear before
statement voting.

```bash
node packages/cli/dist/index.js web --project projects/open-contracts-demo --port 4310
```

Open `http://127.0.0.1:4310` and inspect the Statements page, the report voting
summary, and the project artifact status.

```bash
open projects/open-contracts-demo/reports/demo-run/site/index.html
```

The static site should open directly from disk and include statement, vote, and
attestation data.
