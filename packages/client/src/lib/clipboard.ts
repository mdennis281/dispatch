/**
 * Clipboard access, kept out of `panelBus` so reaching for a copy button doesn't
 * pull in the right-panel/Monaco decoupling seam. Nothing here is panel-shaped.
 */

/** Best-effort copy to the OS clipboard (localhost is a secure context). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
