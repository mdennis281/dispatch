/**
 * A browser-owned lease for image preview bytes.
 *
 * Blob URLs retain their Blob until explicitly revoked. Returning the cleanup
 * beside the URL makes the CodeViewer effect release that memory both when the
 * panel closes and when it switches to another file.
 */
export function leaseImagePreview(blob: Blob): { src: string; dispose: () => void } {
  const src = URL.createObjectURL(blob);
  let disposed = false;
  return {
    src,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      URL.revokeObjectURL(src);
    },
  };
}
