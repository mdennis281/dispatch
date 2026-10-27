# Installing, versioning, shipping

## Where plugins live

`<configDir>/plugins/<id>/`. The config root is the directory `config.json` is in —
`DISPATCH_CONFIG_DIR` for the server, shown under Settings → System in the app, and
`<repo>/.data` for a source checkout with nothing set. It is **shared by the stable
(installed) and dev instances and never replaced by an upgrade**, so a plugin installed
once is seen by both and survives every publish. There is no project-scoped plugin; a
project opts out of a plugin's MCP server through its ordinary `mcpEnabled` map.

## `dispatch plugin`

```
dispatch plugin init <id> [--server|--client|--both] [--name <n>] [--dir <parent>] [--sdk <path>]
dispatch plugin add <path | git-url | .tgz>   validate in the SOURCE, then copy to plugins/<id> (tmp dir + rename, so an
                                        interrupted copy never leaves a half-plugin); prints the consent summary
dispatch plugin link <path>                   junction (Windows) / symlink a working directory — edits are live on the next restart
dispatch plugin list | enable <id> | disable <id>
dispatch plugin update [<id>] [--check] [--yes]   follow the recorded source (git installs only)
dispatch plugin remove <id> [--purge] [--data-dir <dir>]
      --config-dir <dir>   (or DISPATCH_CONFIG_DIR)    -f, --force   replace an installed plugin    --json
```

`init` writes a standalone directory; `--name` is the display name and is kept to
letters, digits, spaces and `. _ ( ) + & ' ! ? , -` because it is spliced into YAML
and TSX (edit `name:` in `plugin.yaml` afterwards for anything else).

`add` takes a directory, a git URL (shallow clone) or a tarball, finds `plugin.yaml` at
the root or one directory down, and refuses an invalid or incompatible manifest BEFORE
anything lands under the root. It claims the slot by the **manifest's id**, not the
source directory's name, and leaves `.git` and `node_modules` behind — a built plugin
needs neither (the SDK's presets inline every dependency), and `node_modules` of a
scaffold holds a `link:` to the SDK that `dereference` would copy through. `remove`
deletes a copy and unlinks a link (the working directory is untouched).
`enable`/`disable` flip `AppSettings.plugins[id].enabled` in `config.json`; Settings →
Plugins does the same live.

## Installing from a URL (Settings → Plugins → Inspect from URL)

The owner can paste your repository's URL and get a report before installing: what
the manifest declares, what the code was statically seen using, and any mismatch
between the two. Install then copies **exactly the inspected commit** — the
repository tree as it is at that sha, never built. So, if you want people to
install from a URL:

- **Commit the built entries** (`server/index.js`, `client/index.js`) or the report
  warns that they are missing and the plugin will not load. The scaffold's
  `.gitignore` excludes them; drop those lines for a published plugin.
- **Declare every capability you use.** The report lists `ctx.chats.send` without
  `chats:write`, and a declared capability with no use, as mismatches.
- Keep `ctx` / `host` (or `activate`'s parameter) as the name you call through; an
  alias the scan does not follow shows as "nothing uses it".

## Several plugins in one repository

Put each plugin in its own directory and users can paste the **repository** URL
instead of one `/tree/<ref>/<dir>` link per plugin: Inspect lists every plugin
in it to tick, and `dispatch plugin add <url> --plugin <path|id>` / `--all` does
the same from the CLI. Don't put a `plugin.yaml` at the repository root — a
directory with its own manifest is always one plugin.

Add `dispatch-plugins.yaml` at the root to choose and order what is listed
(otherwise every directory holding a `plugin.yaml` is):

```yaml
name: Home lab
description: Plugins for the boxes in the closet
plugins:
  - plugins/hass
  - plugins/proxmox
```

Paths only — names, versions and capabilities come from each `plugin.yaml`.
Each plugin installs and updates on its own; tag releases per plugin
(`hass-v1.2.0`) so tag-following users only see their plugin's releases.

## How your users get updates

A URL install records where it came from (in the host's config, not your plugin
dir), and **Check for updates** follows it: a **branch** URL updates to the branch's
latest commit, a **tag** URL to the newest higher semver tag *with the same prefix*
(`v1.2.0` → `v1.3.0`; in a monorepo, tag per plugin as `myplugin-v1.2.0`), and a
**sha** URL is pinned. Prereleases (`v2.0.0-beta.1`) are only offered to someone
already on a prerelease. So: bump `version:` in `plugin.yaml` with every release, and
tag releases if you want users on a tag to see them.

Dispatch also checks in the background (every 6 hours by default). Per plugin
the owner picks **Notify** (the default: an announcement, nothing installed),
**Auto-update** (installs an update that asks for nothing new; it loads on their
next restart) or **Off**. So: an update that adds a capability, secret, OAuth
client or scope, MCP server or process will never auto-install — expect your
users to read and click for those. In a repository of several plugins, a push
that does not touch your plugin's directory is not an update to it.

Before updating, the owner sees what the new version asks for that the installed
one did not — new capabilities, secrets, OAuth clients or scopes, MCP servers,
processes, undeclared uses. Keep those changes rare and say why in your README;
`dispatch plugin update` will not install such an update without `--yes`. The
plugin's settings, kv, secrets and OAuth sign-ins survive an update (they are keyed
by the id, outside the directory), so do not rename `id:`. An update to a different
id is refused.

## The restart rule

Plugins are discovered and read at boot; **nothing hot-reloads**. After `add`, `link`,
`enable`, editing a linked plugin's files, or changing any contribution, restart the
instance that should see it — both, if both should. The one exception is the toggle in
Settings → Plugins: **off** deactivates immediately (routes 404, listeners dropped,
processes stopped, client bundle pulled on next load); **on** records the wish and the
row says "restart to apply". Settings edits (`PUT /api/plugins/:id/settings`) reach a
running plugin through `ctx.settings.onChange` without a restart.

Restart the way the house rules say: `pnpm app:stop` / Settings → Stop for the
installed app, Ctrl-C for `pnpm dev`. Never `taskkill` the server.

## Versioning

Two numbers, two jobs:

- `version:` in `plugin.yaml` is **yours** (semver, shown on the Settings row, not
  interpreted by the host). Bump it when you ship a change.
- `dispatch:` is a range over the host's `PLUGIN_API_VERSION` (currently `1`). The
  plugin API is **additive within a major**: new context members, slots and manifest
  fields arrive without a bump, and `">=1"` keeps working. The major bumps only when a
  member is removed or changes meaning, and then the host lists you as `incompatible`
  rather than crashing at activate.

`@dispatch/plugin-sdk` is versioned with the host and is not on npm. A scaffold links
it from the checkout that ran `dispatch plugin init`, so the types you compile against are the
host you install into. Building against a newer checkout than the running host is fine
as long as nothing you use is newer than the host's API major.

## Shipping to someone else

A plugin is a directory. Tar it (`tar -czf my-plugin.tgz -C .. my-plugin`, after
`pnpm build`, without `node_modules`) or push it to a git repository with `plugin.yaml`
at the root; `dispatch plugin add <url|tgz>` on the other side. Include `server/` and
`client/` build output in what you ship — the receiver should not need your toolchain.

## If you change THIS skill (or any bundled skill)

Bundled skills are **materialized once per checkout** into `<cwd>/.claude/skills/` and
never refreshed — the materializer skips any target that already exists, so a repo's
own skill of the same name can win. After changing `packages/server/skills/plugin-authoring/`,
the source fix is not enough: delete `.claude/skills/plugin-authoring/` in every
checkout that has run a session (`Remove-Item -Recurse -Force <checkout>\.claude\skills\plugin-authoring`),
after the new build is live, and the next session re-materializes it. Also keep
`node tools/verify/no-stale-tool-names.mjs` green — it greps bundled skills too.
