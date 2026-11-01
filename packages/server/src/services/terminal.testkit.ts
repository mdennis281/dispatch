/**
 * For the scripted fake shells in the terminal tests: the command a write
 * carries, as the agent typed it.
 *
 * Core sends each command wrapped so it can't read the shell's pipe
 * (`commandWrite`). A fake that matched `^say hi` against the raw write would
 * see `eval 'say hi` and do nothing, and every run would time out. Probe
 * writes, and anything else that isn't a command write, come back unchanged.
 */
export function unwrapCommandWrite(chunk: string): string {
  // Foreground: `eval '…\n' </dev/null\n`. Background: `eval '…\n' ; `, the
  // line finished by the probe.
  const posix = chunk.match(/^eval '([\s\S]*)\n' (?:<\/dev\/null\n|; )$/);
  if (posix) return posix[1]!.replace(/'\\''/g, "'") + "\n";
  // PowerShell: the stdin line (with the helper's compile on a shell's first
  // command) precedes the command itself.
  const nl = chunk.indexOf("\n");
  if (nl >= 0 && /::(Detach|Hold)\(\)/.test(chunk.slice(0, nl))) return chunk.slice(nl + 1);
  return chunk;
}
