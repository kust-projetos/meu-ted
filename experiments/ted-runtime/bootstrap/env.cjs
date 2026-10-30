// Isolation setup. MUST run before importing @opencode/* (global roots are
// captured at module import time). Sets process env to identity-scoped dirs
// under TED_HOME_ROOT and scrubs credential-bearing vars (values never logged).
const SCRUB = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY', 'CLOUDFLARE_API_TOKEN', 'DATABASE_URL',
  'SESSION_BEARER_FALLBACK_ENABLED', 'EVOLUTION_GO_API_KEY',
];
function setupIsolation(identity) {
  const root = process.env.TED_HOME_ROOT;
  if (!root) throw new Error('TED_HOME_ROOT not set');
  const fs = require('fs');
  const path = require('path');
  const home = path.join(root, `.ted-home-${identity}`);
  const dirs = {
    home,
    config: path.join(home, 'config'),
    data: path.join(home, 'data'),
    cache: path.join(home, 'cache'),
    state: path.join(home, 'state'),
    tmp: path.join(home, 'tmp'),
    workspace: path.join(home, 'workspace'),
    db: path.join(home, 'db', 'ted.db'),
  };
  for (const d of [dirs.config, dirs.data, dirs.cache, dirs.state, dirs.tmp, dirs.workspace, path.dirname(dirs.db)]) {
    fs.mkdirSync(d, { recursive: true });
  }
  process.env.OPENCODE_TEST_HOME = home;
  process.env.XDG_CONFIG_HOME = dirs.config;
  process.env.XDG_DATA_HOME = dirs.data;
  process.env.XDG_CACHE_HOME = dirs.cache;
  process.env.XDG_STATE_HOME = dirs.state;
  process.env.TMPDIR = dirs.tmp;
  process.env.TEMP = dirs.tmp;
  process.env.TMP = dirs.tmp;
  process.env.OPENCODE_CONFIG_DIR = dirs.config;
  const scrubbed = [];
  for (const k of SCRUB) {
    if (process.env[k] !== undefined) {
      delete process.env[k];
      scrubbed.push(k);
    }
  }
  // Never touch SSH, repos, docker socket, or the real HOME.
  return { identity, home, dirs, scrubbed };
}

module.exports = { setupIsolation };
