/**
 * REST for chat assets (images the composer pastes/drops, and sprites the agent
 * produces). Uploads are base64 / data-URL JSON (no multipart dependency); the
 * bytes are persisted under the chat's assets/ dir and an `ImageRef` is returned
 * that `send-message` can carry straight to the SDK.
 *   POST /api/chats/:id/assets  { data, mimeType?, alt?, width?, height?, filename? } → ImageRef
 *   GET  /api/chats/:id/assets/:name → the raw image bytes (inline display)
 */
import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { ImageRefSchema, chatRoot } from "@dispatch/shared";
import { extFromMediaType, mediaTypeFromName } from "../services/media-types.js";
import { identifyMedia } from "../services/media-sniff.js";
import {
  isDenied,
  openFsAsset,
  resolveFsAsset,
  type FsAssetDenial,
} from "../services/fs-assets.js";

/** Cap a single upload so a runaway paste can't fill the disk / RAM. */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * Parse a single-range `Range: bytes=…` header against a known size.
 *
 * `<video>` will not let you SEEK unless the server answers 206 — without this
 * a chat recording plays from the start and nowhere else. Only the single-range
 * form is honored; a multi-range request falls back to the whole file, which is
 * a legal (if unhelpful) response and far simpler than multipart/byteranges.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // `bytes=-N` — the LAST n bytes, not a range starting at zero.
    const n = Number(rawEnd);
    if (n <= 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Only keep a positive integer dimension (ImageRefSchema is strict). */
function posInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

export function registerAssetRoutes(app: FastifyInstance): void {
  const { store } = app.cm;

  app.post<{ Params: { id: string } }>(
    "/api/chats/:id/assets",
    async (req, reply) => {
      const chat = await store.getChat(req.params.id);
      if (!chat) return reply.code(404).send({ error: "chat not found" });

      const body = (req.body ?? {}) as {
        data?: string;
        mimeType?: string;
        alt?: string;
        width?: number;
        height?: number;
        filename?: string;
      };
      if (typeof body.data !== "string" || body.data.length === 0) {
        return reply
          .code(400)
          .send({ error: "data (base64 or data URL) required" });
      }

      let mime = body.mimeType;
      let b64 = body.data;
      const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(body.data);
      if (dataUrl) {
        mime = mime ?? dataUrl[1] ?? undefined;
        b64 = dataUrl[3];
      }

      let buf: Buffer;
      try {
        buf = Buffer.from(b64, "base64");
      } catch {
        return reply.code(400).send({ error: "invalid base64 payload" });
      }
      if (buf.length === 0) return reply.code(400).send({ error: "empty image" });
      if (buf.length > MAX_UPLOAD_BYTES) {
        return reply.code(413).send({ error: "image too large" });
      }

      // Prefer the declared type's canonical extension; fall back to the
      // uploaded filename's, then to .png (this route is the composer's paste
      // path, so an image is the overwhelmingly likely truth).
      const ext = extFromMediaType(
        mime,
        body.filename ? extname(body.filename).toLowerCase() : ".png",
      );
      const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : ".png";
      mime = mime ?? mediaTypeFromName(safeExt);

      // The bytes get the final say on type and size. A composer paste carries
      // whatever the OS clipboard claimed, and a drop carries whatever the
      // filename implied — both are routinely wrong, and a wrong content-type
      // is a picture the browser refuses to paint.
      const sniffed = identifyMedia(buf, mime);
      const realExt = extFromMediaType(sniffed.mimeType, safeExt);
      const name = `${nanoid()}${/^\.[a-z0-9]+$/.test(realExt) ? realExt : safeExt}`;
      const relPath = await store.writeChatAsset(req.params.id, name, buf);

      const parsed = ImageRefSchema.safeParse({
        id: nanoid(),
        path: relPath,
        mimeType: sniffed.mimeType,
        alt: typeof body.alt === "string" ? body.alt : undefined,
        // A caller-supplied dimension wins: the composer measures the decoded
        // image, which is authoritative for formats this can't parse.
        width: posInt(body.width) ?? sniffed.width,
        height: posInt(body.height) ?? sniffed.height,
      });
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      return reply.code(201).send(parsed.data);
    },
  );

  app.get<{ Params: { id: string; name: string } }>(
    "/api/chats/:id/assets/:name",
    async (req, reply) => {
      // Size first, bytes second. An asset can now be a referenced video of a
      // few hundred MB, so reading the whole file to slice four bytes out of it
      // would spike memory per request — and undo the point of range support.
      const info = await store.statChatAsset(req.params.id, req.params.name);
      if (!info) return reply.code(404).send({ error: "not found" });
      reply.header("content-type", mediaTypeFromName(req.params.name));
      reply.header("cache-control", "private, max-age=31536000, immutable");
      // Advertised unconditionally: a browser decides whether to seek by looking
      // for this on the FIRST (rangeless) response, so omitting it here means it
      // never asks for a range at all.
      reply.header("accept-ranges", "bytes");

      const range = parseByteRange(req.headers.range, info.size);
      if (range === "unsatisfiable") {
        reply.header("content-range", `bytes */${info.size}`);
        return reply.code(416).send();
      }
      const stream = store.openChatAsset(
        req.params.id,
        req.params.name,
        range ?? undefined,
      );
      // Raced with a delete between the stat and the open.
      if (!stream) return reply.code(404).send({ error: "not found" });
      if (range) {
        reply.header("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
        reply.header("content-length", String(range.end - range.start + 1));
        return reply.code(206).send(stream);
      }
      reply.header("content-length", String(info.size));
      return reply.send(stream);
    },
  );

  /**
   * A file the AGENT wrote, served as a renderable asset.
   *
   *   GET /api/chats/:id/fs-asset?path=out/chart.png
   *
   * The commonest way an image reaches a human is that a script wrote it and
   * the agent named the path — no MCP block, no bytes on the wire, nothing for
   * the asset pipeline to catch. Without this the markdown `![](out/chart.png)`
   * resolves against the SPA origin and 404s into the broken-image glyph.
   *
   * Relative paths resolve against the chat's worktree, because that is where
   * the agent that wrote them was standing. Confinement, type-sniffing and the
   * size cap all live in `resolveFsAsset` — see there for why each is load-
   * bearing.
   */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/chats/:id/fs-asset",
    async (req, reply) => {
      const wanted = (req.query.path ?? "").trim();
      if (!wanted) return reply.code(400).send({ error: "path required" });

      const chat = await store.getChat(req.params.id);
      if (!chat) return reply.code(404).send({ error: "chat not found" });
      const project = await store.getProject(chat.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });

      // Order matters: the chat's own worktree is roots[0] and therefore the
      // base a relative path resolves against. The project checkout is included
      // because plenty of output lands there, and tmp because that is where
      // capture tools stage a file before naming it.
      const roots = [chatRoot(chat, project), project.repoPath, tmpdir()].filter(Boolean);
      const found = await resolveFsAsset(wanted, roots);
      if (isDenied(found)) {
        return reply.code(DENIAL_STATUS[found.denied]).send({ error: found.denied });
      }

      reply.header("content-type", found.mimeType);
      // `nosniff` so a browser can never re-interpret these bytes as something
      // more privileged than the type we sniffed them to be.
      reply.header("x-content-type-options", "nosniff");
      // An SVG rendered through `<img>` cannot run script, but a human who opens
      // this URL in a tab renders it as a DOCUMENT, where it can. The sandbox
      // CSP closes that without blocking the picture.
      if (found.mimeType === "image/svg+xml") {
        reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
      }
      // Deliberately NOT `immutable` like the chat-asset route: that one serves
      // content-addressed names that can never change, while this serves a live
      // working-tree path whose bytes are rewritten every time the agent re-runs
      // its script. Caching it hard would pin the FIRST chart forever.
      reply.header("cache-control", "private, no-cache");
      reply.header("accept-ranges", "bytes");

      const range = parseByteRange(req.headers.range, found.size);
      if (range === "unsatisfiable") {
        reply.header("content-range", `bytes */${found.size}`);
        return reply.code(416).send();
      }
      if (range) {
        reply.header("content-range", `bytes ${range.start}-${range.end}/${found.size}`);
        reply.header("content-length", String(range.end - range.start + 1));
        return reply.code(206).send(openFsAsset(found.path, range));
      }
      reply.header("content-length", String(found.size));
      return reply.send(openFsAsset(found.path));
    },
  );
}

/**
 * Denials map to distinct statuses so the client can tell "typo" from "not
 * allowed" from "that isn't a picture" — a single 404 for all three makes a
 * confinement rejection indistinguishable from a missing file when debugging.
 */
const DENIAL_STATUS: Record<FsAssetDenial, number> = {
  "not-found": 404,
  forbidden: 403,
  "too-large": 413,
  "not-media": 415,
};
