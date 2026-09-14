/**
 * Resolve the Electron executable for the current platform.
 *
 * Handing this to the `electron` package rather than building the path
 * ourselves is the whole point: the binary is `dist/electron.exe` on Windows,
 * `dist/electron` on Linux, but `dist/Electron.app/Contents/MacOS/Electron` on
 * macOS -- and a hardcoded `dist/electron` fails there with ENOENT.
 *
 * Imported from a plain Node process, `electron` resolves to its installer
 * package, whose default export is exactly this path.
 */

export async function electronBinary() {
  const resolved = (await import('electron')).default;
  if (typeof resolved !== 'string' || resolved === '') {
    throw new Error('could not resolve the Electron binary; run `npm install` first');
  }
  return resolved;
}
