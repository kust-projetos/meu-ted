// TED policy config writer. No-BOM UTF-8 (BOM breaks opencode JSONC decode).
// Native-first: uses ONLY provider.use + tool.use policies and V2 permissions.
// Deliberately does NOT use mcp.use/skill.use/plugin.use (unenforced in 2.2.4
// on the paths TED exercises; enforcement observed only in prompt-loop paths
// that require LLM inference, which this experiment never invokes).
const fs = require('fs');
const path = require('path');

function tedConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    // TED agent: primary, least privilege. V2 permission actions only.
    agents: {
      ted: {
        mode: 'primary',
        description: 'TED synthetic experiment agent (no tools)',
        permissions: [
          { action: 'shell', resource: '*', effect: 'deny' },
          { action: 'edit', resource: '*', effect: 'deny' },
          { action: 'subagent', resource: '*', effect: 'deny' },
        ],
      },
    },
    // Policy layer: provider.use + tool.use only.
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'tool.use', resource: 'shell:*', effect: 'deny' },
      { action: 'tool.use', resource: 'edit:*', effect: 'deny' },
      { action: 'tool.use', resource: 'write:*', effect: 'deny' },
      { action: 'tool.use', resource: 'subagent:*', effect: 'deny' },
    ],
  };
}

function writeTedConfig(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, 'opencode.json');
  // No BOM on purpose: BOM-prefixed files are rejected by Config.parseInfo.
  fs.writeFileSync(file, JSON.stringify(tedConfig(), null, 2) + '\n', { encoding: 'utf8' });
  return file;
}

module.exports = { tedConfig, writeTedConfig };
