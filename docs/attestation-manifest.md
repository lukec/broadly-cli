# Attestation Manifest

Attestations are unsigned hash manifests in the first implementation. They are
intended to make local report and statement artifacts independently checkable
without introducing signing key management yet.

Locations:

```text
attestations/reports/<analysis-run-id>.attestation.json
attestations/statements/<statement-run-id>.attestation.json
```

Each `AttestationManifest` records:

- subject kind and ids
- package/code version
- publication timestamp
- registered model references
- artifact paths, kinds, SHA-256 hashes, and required flags

Verify all local attestations:

```bash
broadly verify
```

Verify one manifest:

```bash
broadly verify --manifest attestations/reports/<analysis-run-id>.attestation.json
```

