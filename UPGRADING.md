# Upgrading

Upgrade in place with the package manager you installed with:

```bash
loki self-update            # detects npm, Bun or Homebrew and upgrades
loki self-update --check    # print the detected manager and exit
```

Or run the manager directly:

| Method | Upgrade |
|--------|---------|
| npm | `npm update -g loki-mode` |
| Bun | `bun update -g loki-mode` |
| Homebrew | `brew upgrade loki-mode` |

Then confirm the install:

```bash
loki --version
loki doctor
```

## What changed

Every release is listed in [CHANGELOG.md](CHANGELOG.md), newest first. Read the entries between your old version and the new one before upgrading a CI pipeline or a pinned GitHub Action.

## Rolling back

Install the previous version explicitly, for example `npm install -g loki-mode@<version>`. Run state in `.loki/` (per project) and `~/.loki/` is kept across upgrades and rollbacks.

## More

- [Installation](docs/INSTALLATION.md)
- [Known issues](docs/KNOWN-ISSUES.md)
