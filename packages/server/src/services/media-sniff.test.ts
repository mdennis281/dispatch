import { describe, it, expect } from "vitest";
import { identifyMedia, imageSize, sniffMediaType } from "./media-sniff.js";

/** A 2x3 PNG header — IHDR is fixed-offset, so nothing else has to be real. */
function png(width = 2, height = 3): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** A baseline JPEG with one preceding APP0 segment, so the walk has to work. */
function jpeg(width = 7, height = 11): Buffer {
  const parts: number[] = [0xff, 0xd8];
  // APP0, length 6, four bytes of junk — must be SKIPPED, not parsed as a frame.
  parts.push(0xff, 0xe0, 0x00, 0x06, 1, 2, 3, 4);
  // SOF0: length 11, precision 8, height, width, 1 component.
  parts.push(0xff, 0xc0, 0x00, 0x0b, 0x08);
  parts.push((height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff);
  parts.push(0x01, 0x01, 0x11, 0x00);
  return Buffer.from(parts);
}

function gif(width = 5, height = 9): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** A lossless WebP (VP8L), whose size is bit-packed rather than byte-aligned. */
function webpLossless(width = 17, height = 33): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8L", 12, "latin1");
  buf[20] = 0x2f;
  buf.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return buf;
}

describe("sniffMediaType", () => {
  it("identifies the raster formats by magic", () => {
    expect(sniffMediaType(png())).toBe("image/png");
    expect(sniffMediaType(jpeg())).toBe("image/jpeg");
    expect(sniffMediaType(gif())).toBe("image/gif");
    expect(sniffMediaType(webpLossless())).toBe("image/webp");
    expect(sniffMediaType(Buffer.from("BM\x00\x00\x00\x00", "latin1"))).toBe("image/bmp");
  });

  it("distinguishes RIFF containers by their form type", () => {
    const wav = Buffer.alloc(12);
    wav.write("RIFF", 0, "latin1");
    wav.write("WAVE", 8, "latin1");
    expect(sniffMediaType(wav)).toBe("audio/wav");
  });

  it("distinguishes ISO-BMFF images from video by brand", () => {
    const box = (brand: string): Buffer => {
      const b = Buffer.alloc(16);
      b.write("ftyp", 4, "latin1");
      b.write(brand, 8, "latin1");
      return b;
    };
    expect(sniffMediaType(box("avif"))).toBe("image/avif");
    expect(sniffMediaType(box("heic"))).toBe("image/heic");
    expect(sniffMediaType(box("isom"))).toBe("video/mp4");
    expect(sniffMediaType(box("qt  "))).toBe("video/quicktime");
  });

  describe("SVG", () => {
    it("recognizes a bare root tag", () => {
      expect(sniffMediaType(Buffer.from('<svg xmlns="x"/>'))).toBe("image/svg+xml");
    });

    it("recognizes one behind a prolog, doctype or comment", () => {
      for (const head of [
        '<?xml version="1.0"?><svg/>',
        "<!DOCTYPE svg><svg/>",
        "<!-- generated --><svg/>",
        '﻿<?xml version="1.0"?>\n<svg/>',
      ]) {
        expect(sniffMediaType(Buffer.from(head)), head).toBe("image/svg+xml");
      }
    });

    it("does not claim an HTML page that merely contains an svg", () => {
      // Labelling this `image/svg+xml` would make the browser refuse to render
      // a document it would otherwise have shown.
      expect(sniffMediaType(Buffer.from("<html><body><svg/></body></html>"))).toBeUndefined();
    });
  });

  it("has no opinion on bytes it doesn't know", () => {
    expect(sniffMediaType(Buffer.from("just some text here"))).toBeUndefined();
    expect(sniffMediaType(Buffer.alloc(2))).toBeUndefined();
  });
});

describe("imageSize", () => {
  it("reads PNG, GIF and BMP from fixed offsets", () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(gif(12, 34))).toEqual({ width: 12, height: 34 });
  });

  it("walks JPEG segments past a preceding APP0", () => {
    expect(imageSize(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("unpacks a lossless WebP's bit-packed size", () => {
    expect(imageSize(webpLossless(300, 200))).toEqual({ width: 300, height: 200 });
  });

  it("reads SVG width/height, falling back to the viewBox", () => {
    expect(imageSize(Buffer.from('<svg width="40" height="20"/>'))).toEqual({
      width: 40,
      height: 20,
    });
    // A percentage width describes the container, not the image — the viewBox
    // is the only real answer, and this is the common case for generated SVG.
    expect(imageSize(Buffer.from('<svg width="100%" height="100%" viewBox="0 0 800 600"/>'))).toEqual(
      { width: 800, height: 600 },
    );
  });

  it("returns undefined rather than throwing on a truncated header", () => {
    expect(imageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeUndefined();
  });

  it("rejects a zero dimension, which ImageRefSchema would refuse anyway", () => {
    expect(imageSize(png(0, 10))).toBeUndefined();
  });
});

describe("identifyMedia", () => {
  it("overrides a wrong declaration with the sniffed truth", () => {
    // The single largest source of "the image is broken": a tool labels a PNG
    // `application/octet-stream`, it gets stored as .bin, and the browser
    // refuses to paint the content-type it is served back with.
    expect(identifyMedia(png(4, 4), "application/octet-stream")).toEqual({
      mimeType: "image/png",
      width: 4,
      height: 4,
    });
    expect(identifyMedia(png(4, 4), "image/jpeg").mimeType).toBe("image/png");
  });

  it("keeps a declaration sniffing has no opinion on", () => {
    expect(identifyMedia(Buffer.from("....."), "image/jxl").mimeType).toBe("image/jxl");
  });

  it("falls back to octet-stream when nobody knows", () => {
    expect(identifyMedia(Buffer.from("....."), undefined).mimeType).toBe(
      "application/octet-stream",
    );
  });
});
