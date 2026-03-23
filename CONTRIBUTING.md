# Contributing

## Local setup

```bash
make setup    # creates .env with generated secrets
# edit .env to add your OpenRouter API key
make install  # install dependencies
make dev      # start dev server + database
```

## Running tests

```bash
make test
```

## Pull requests

- Keep PRs focused on a single change
- Follow existing code patterns and conventions
- Include a clear description of what changed and why
- Make sure `make test` passes before submitting

## CI/CD

Every push to `main` (with code changes) runs tests, then builds and publishes a Docker image to `ghcr.io/wheelhouz/open-brain` tagged as `:latest` and `:sha-<short commit hash>`. Docs-only changes skip CI.

Pull requests run tests only -- no publish.

## Releasing

To create a named release, either:

**From the CLI:**
```bash
git tag v1.1.0
git push origin v1.1.0
```

**From GitHub UI:**
Go to Releases > Draft a new release > choose a tag (e.g. `v1.1.0`) > publish.

Both methods trigger the CI workflow, which builds and tags the Docker image as `:1.1.0` + `:latest` and creates a GitHub Release with auto-generated notes.

Use [semver](https://semver.org): patch (1.0.1) for fixes, minor (1.1.0) for features, major (2.0.0) for breaking changes.
