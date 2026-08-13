# Security

## Credential model

Dispatch does not require provider API keys in this repository. It uses the
authenticated Claude Code or Codex CLI already installed on the machine. GitHub
operations similarly use the local `gh` authentication context.

Never commit credentials to `.dispatch/project.yaml`. That file is intentionally
tracked. MCP secrets must be environment-variable placeholders such as
`${LINEAR_API_KEY}`; Dispatch expands them only in memory when a session starts.

Local state, credential-shaped files, environment files, build output, and test
artifacts are ignored. CI also scans incoming commits with Gitleaks on every
change; the existing history is audited before publication.

## Network exposure

The default bind address is `127.0.0.1`. Setting `DISPATCH_HOST=0.0.0.0` exposes a
control plane that can run commands as your user and currently has no application
authentication. Enable it only on a network you trust; never expose it directly
to the public internet.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or a private Security
Advisory for this repository. Do not open a public issue containing exploit
details, credentials, or personal data.
