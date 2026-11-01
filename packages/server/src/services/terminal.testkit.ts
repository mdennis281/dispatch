/**
 * For the scripted fake shells in the terminal tests: the command a write
 * carries, as the agent typed it.
 *
 * Core sends each command wrapped so it reads EOF instead of the shell's pipe
 * (`commandWrite`). A fake that matched `^say hi` against the raw write would
 * see `eval 'say hi` and do nothing, and every run would time out. Probe
 * writes, and anything else that isn't a command write, come back unchanged.
 */
export function unwrapCommandWrite(chunk: string): string {
  const posix = chunk.match(/^eval '([\s\S]*)\n' <\/dev\/null\n$/);
  if (posix) return posix[1]!.replace(/'\\''/g, "'") + "\n";
  // PowerShell: the stdin-detach line (with the helper's compile on a shell's
  // first command) precedes the command itself.
  const nl = chunk.indexOf("\n");
  if (nl >= 0 && chunk.slice(0, nl).includes("::Detach()")) return chunk.slice(nl + 1);
  return chunk;
}
