# Open Contracts Fixture

This fixture path is exercised by:

```bash
npm run smoke:open-contracts
```

The script creates an ignored throwaway project at:

```text
projects/open-contracts-fixture/
```

It avoids model calls and runs the open contract loop:

1. create a synthetic report bundle and supporting analysis artifacts
2. generate a statement bank
3. accept generated statements
4. run statement QA
5. initialize a local vote round
6. seed deterministic synthetic votes
7. analyze, export, and attach vote results
8. attest report and statement artifacts
9. verify hashes
10. export a static report site

The final site is written to:

```text
projects/open-contracts-fixture/reports/demo-run/site/index.html
```

