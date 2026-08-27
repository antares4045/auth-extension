# Repository workflow

## Commits

- Change `manifest.json.version` in every commit.
- Apply Semantic Versioning: patch for fixes and maintenance, minor for backward-compatible features, and major for breaking changes.
- A commit is ready only when its staged diff includes the intended version change and the relevant tests pass.
