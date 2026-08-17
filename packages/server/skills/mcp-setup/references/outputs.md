# Returning images, video, and files from a tool

The rule that decides everything here: **anything you return inline goes through
the model's context window.** For a screenshot that's the point — the model
should see it. For a video it is pure waste: megabytes of base64 the model
cannot watch, costing more than the conversation around it.

So there are two routes, and picking the right one is most of the job.

| Returning | Route | Why |
|---|---|---|
| A screenshot the model should reason about | inline base64 image | it needs to see it |
| A video, a recording, a large capture | **reference** | only the human watches it |
| A zip, a log, a report, a build artifact | **reference** | ditto |
| A small image the human just wants to glance at | either | reference is cheaper |

## Route 1 — a reference (preferred for anything large)

Write the file wherever you like, then name it. Dispatch copies it into the
chat's assets, renders a player or a download chip, and hands the model one short
line: `[video: run.mp4 — 4.2 MB, shown to the user]`.

**Standard spelling** — MCP's own `resource_link`. A server written against the
spec needs no Dispatch-specific code:

```ts
return {
  content: [
    { type: "text", text: "Recorded 12s of the failing interaction." },
    {
      type: "resource_link",
      uri: `file://${outPath}`,
      name: "run.mp4",
      mimeType: "video/mp4",
    },
  ],
};
```

**Escape hatch** — when your SDK can't emit a `resource_link`, a text block that
is exactly this envelope works identically:

```ts
return {
  content: [
    { type: "text", text: JSON.stringify({ dispatch: "asset", path: outPath, alt: "run.mp4" }) },
  ],
};
```

Notes:

- **Write inside the chat's directory or the OS temp dir.** A reference is only
  ingested if it resolves (after following symlinks) inside one of those two
  roots. Anything else is refused and your original block is left as-is.
  Otherwise "copy the file this server names" would be an arbitrary local-file
  read — harmless-ish for a stdio server, which already runs with the manager's
  filesystem access, but a *remote* http/sse server has none of its own and
  could return `file:///etc/passwd` to borrow it.
- A relative path resolves against the chat's own directory, so a path relative
  to your server's cwd lands in the right worktree.
- `mimeType` is optional — it's inferred from the extension otherwise. Supply it
  when the extension is unusual.
- An `alt`/`name` becomes the caption; the filename is used if you omit it.
- A `resource` block that carries `text` or `blob` is treated as inline, not a
  reference — that payload is already in hand.
- Cap: 256 MB per referenced file. Missing or unreadable files leave your
  original block untouched rather than failing the call.

## Route 2 — inline base64 (small images, short clips)

The existing image path, unchanged:

```ts
return { content: [{ type: "image", data: b64, mimeType: "image/png" }] };
```

Video and audio types work here too, but there is an **8 MB ceiling**. Over it,
the block is replaced by a message pointing you at route 1 — rather than being
stored silently, which would teach servers that inlining video is fine.

If you find yourself base64-ing a video: that's the signal to switch routes.

## What the user sees

- **image** — thumbnail, click to enlarge
- **video** — inline player with a seek bar
- **audio** — inline player
- **anything else** — a download chip

Video and audio are downloaded in full before playback starts (chat assets are
served over an authenticated endpoint, so the bytes are fetched with the session
token rather than streamed by the element). Scrubbing works once loaded. Keep
captures short — this is for "watch what just happened", not for hosting media.

## Keeping a tool's text output cheap

Same principle, and the more common problem in practice:

- **Bound every list.** A tool that can return a 50k-token blob will poison the
  context. Paginate, cap, and say in the description that it's capped.
- **Summarize, then offer detail.** Return the counts and the first N, with a
  parameter to fetch more — don't return everything in case it's wanted.
- **A file on disk is cheaper than a wall of text.** A 400-line report is better
  returned as a reference the human can open than pasted into the transcript.
- **Errors are text with `isError: true`**, explaining what to do differently.
  Never throw a raw stack trace at the agent.
