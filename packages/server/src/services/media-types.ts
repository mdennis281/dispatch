/**
 * Media-type lookups for the server.
 *
 * The tables themselves moved to `@dispatch/shared`: the CLIENT now has to make
 * the same call (it renders media the agent referred to by path, before any
 * bytes exist to sniff), and two copies of an extension table is how `.bmp`
 * ended up known to one side and not the other last time.
 *
 * Re-exported from here rather than repointing every import, because "the
 * server's media-type module" is the right name for what call sites want, and
 * `mediaKind`/`formatBytes` have always been re-exported through it for exactly
 * that reason.
 */
export {
  extFromMediaType,
  mediaTypeFromName,
  mediaTypeFromPath,
  mediaKind,
  formatBytes,
  type MediaKind,
} from "@dispatch/shared";
