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

The development/default server bind address is `127.0.0.1`. The installed launcher
explicitly binds `0.0.0.0` so Dispatch is reachable from the LAN (including
`10.0.4.1:4318` on that interface), while its health probe and PWA URL stay on
`127.0.0.1`. This exposes a control plane that can run commands as your user. Authentication is optional and
defaults off for backward compatibility; configure the bootstrap owner in
Settings before enabling host mode outside a trusted network. Non-local passkeys
require HTTPS and a stable canonical hostname.

Passwords use salted Argon2id hashes. Browser sessions use short-lived in-memory
access tokens and rotating HttpOnly refresh cookies; refresh-token families are
bound to a normalized browser/device signature. Accounts and credentials are
shared configuration, while high-write session state remains per Dispatch
instance. Sessions authorize only a stable internal user ID; password, passkey,
TOTP, and future external-provider links resolve to that ID without putting
provider-specific claims into the authorization layer.

If the bootstrap owner is fully locked out, stop Dispatch and reset it locally:

```sh
printf '%s' 'a-new-long-password' | dispatch auth reset-owner \
  --config-dir /path/to/config --data-dir /path/to/data --password-stdin \
  --confirm-stopped
```

The password is accepted only on stdin, never in argv or an environment variable.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or a private Security
Advisory for this repository. Do not open a public issue containing exploit
details, credentials, or personal data.
