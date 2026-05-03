# Statement Bank Format

Statement banks are local JSON artifacts for votable statements derived from a
report, theme, cluster, opinion, or manual seed.

Primary files:

```text
statements/<statement-run-id>/
  manifest.json
  statement-bank.json
  statements/<statement-id>.json
  review/statements/<statement-id>.json
  accepted-statements.json
```

`statement-bank.json` contains `StatementBank` from `@broadly/report-model`.
Each `Statement` records text, kind, moderation status, visibility, source
opinion/cluster/theme ids, evidence refs, generation rationale, duplicate
links, creation time, and provenance.

Generated statements start as `pending` and `admin_only`. Review overlays are
written separately so generated artifacts remain intact. Accepted public
statements can be exported with:

```bash
broadly statements review --export-accepted
```

