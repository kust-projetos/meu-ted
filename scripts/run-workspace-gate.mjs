import { spawnSync } from 'node:child_process';

const gate = process.argv[2];
const allPackages = ['@pi-finance/llm-contracts', 'meu-ted-api', 'pwa', 'pi-finance-agent', 'pi-finance-codex-broker'];
const requestedFilter = process.argv[3] === '--filter' ? process.argv[4] : undefined;
const aliases = {
  contracts: '@pi-finance/llm-contracts',
  '@pi-finance/llm-contracts': '@pi-finance/llm-contracts',
  api: 'meu-ted-api',
  'meu-ted-api': 'meu-ted-api',
  'pi-finance-api': 'meu-ted-api',
  pwa: 'pwa',
  agent: 'pi-finance-agent',
  'pi-finance-agent': 'pi-finance-agent',
  broker: 'pi-finance-codex-broker',
  'pi-finance-codex-broker': 'pi-finance-codex-broker',
};
const packages = requestedFilter ? [aliases[requestedFilter] ?? requestedFilter] : allPackages;
const allowed = new Set(['lint', 'typecheck', 'test', 'build']);

if (!allowed.has(gate)) {
  console.error(`Unknown workspace gate: ${gate ?? '(missing)'}`);
  process.exit(2);
}

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
for (const pkg of packages) {
  const result = spawnSync(command, ['--filter', pkg, gate], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
