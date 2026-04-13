# Contributing

Thanks for contributing.

## Current Standard

This repository is still in Phase 0. Contributions should prioritize:

- clear package boundaries
- inspectable local artifacts
- reproducible config and provenance
- narrow, composable interfaces over premature feature breadth

## Workflow

1. Open an issue or discussion for significant design changes.
2. Keep pull requests narrow.
3. Prefer additive package boundaries over large rewrites.
4. Update docs when behavior or architecture changes.

## Development

```bash
npm install
npm run build
```

## Design Context

The long-form product and strategy context lives in the sibling wiki:

- `/Users/lukec/src/broadly`

If a code change materially changes product assumptions, write that back into the wiki rather than letting the code become the only source of truth.
