// Approved temp roots for tests/boot probes (operator direction).
// win32 only: <homedir>/AppData/Local/Temp/opencode (current user — never
// another user's folder); elsewhere: os.tmpdir(). Falls back to os.tmpdir()
// whenever the approved folder is unusable. Creates UNIQUE subdirs (mkdtemp)
// and NEVER deletes anything — other artifacts there are left untouched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function approvedBase() {
  if (process.platform === 'win32') {
    try {
      const home = os.homedir();
      if (typeof home === 'string' && home.length > 0) {
        return path.join(home, 'AppData', 'Local', 'Temp', 'opencode');
      }
    } catch { /* fall through */ }
  }
  return os.tmpdir();
}

export function approvedTmpRoot(prefix) {
  const base = approvedBase();
  try {
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(path.join(base, `${prefix}-`));
  } catch {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  }
}
