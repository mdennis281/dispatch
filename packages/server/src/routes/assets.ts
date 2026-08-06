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
import { nanoid } from "nanoid";
import { ImageRefSchema } from "@dispatch/shared";

/** Cap a single upload so a runaway paste can't fill the disk / RAM. */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

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

      const ext =
        EXT_BY_MIME[mime ?? ""] ??
        (body.filename ? extname(body.filename).toLowerCase() : "") ??
        ".png";
      const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : ".png";
      mime = mime ?? MIME_BY_EXT[safeExt] ?? "application/octet-stream";

      const name = `${nanoid()}${safeExt}`;
      const relPath = await store.writeChatAsset(req.params.id, name, buf);

      const parsed = ImageRefSchema.safeParse({
        id: nanoid(),
        path: relPath,
        mimeType: mime,
        alt: typeof body.alt === "string" ? body.alt : undefined,
        width: posInt(body.width),
        height: posInt(body.height),
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
      const buf = await store.readChatAsset(req.params.id, req.params.name);
      if (!buf) return reply.code(404).send({ error: "not found" });
      const ext = extname(req.params.name).toLowerCase();
      reply.header("content-type", MIME_BY_EXT[ext] ?? "application/octet-stream");
      reply.header("cache-control", "private, max-age=31536000, immutable");
      return reply.send(buf);
    },
  );
}
