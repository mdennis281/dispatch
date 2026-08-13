export interface InlineResultImage {
  data: string;
  mimeType: string;
}

export interface ParsedResultImages {
  images: InlineResultImage[];
  content: unknown;
}

/** Recover image blocks from transcripts written before Codex MCP images became assets. */
export function parseInlineResultImages(content: unknown): ParsedResultImages {
  if (!Array.isArray(content)) return { images: [], content };

  const images: InlineResultImage[] = [];
  const sanitized = content.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const block = raw as Record<string, unknown>;
    if (block.type === "image" && typeof block.data === "string") {
      const mimeType =
        typeof block.mimeType === "string"
          ? block.mimeType
          : typeof block.mime_type === "string"
            ? block.mime_type
            : "image/png";
      images.push({ data: block.data, mimeType });
      const { data: _data, ...rest } = block;
      return { ...rest, data: "[rendered image]" };
    }
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trimStart().startsWith("{")
    ) {
      try {
        const parsed = JSON.parse(block.text) as Record<string, unknown>;
        if (parsed && Array.isArray(parsed.content)) {
          const nested = parseInlineResultImages(parsed.content);
          if (nested.images.length) {
            images.push(...nested.images);
            return {
              ...block,
              text: JSON.stringify({ ...parsed, content: nested.content }, null, 2),
            };
          }
        }
      } catch {
        // Ordinary text, not a serialized CallToolResult.
      }
    }
    return raw;
  });

  return { images, content: sanitized };
}
