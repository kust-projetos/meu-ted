import { describe, expect, it, vi } from 'vitest';
import { generatedHttpTools } from '../src/generated/http-tools.js';
import {
  buildExposedTools,
  TOOL_DESCRIPTIONS,
  unresolvedCatalogTools,
} from '../src/agent-config/tools.js';

const generatedNames = generatedHttpTools.map(({ name }) => name);
const ctx = {
  workspaceId: 'workspace-test',
  actorId: 'actor-test',
  intentionId: 'intent-test',
  lastUserMessage: 'test',
  fetchImpl: vi.fn(),
};

describe('tool catalog registry contract', () => {
  it('has a registry or native/core implementation for every catalog description', () => {
    expect(unresolvedCatalogTools({
      descriptions: TOOL_DESCRIPTIONS,
      generatedNames,
      nativeNames: [
        'web_search',
        'web_fetch',
        'analytics_kpis',
        'analytics_category_breakdown',
        'remember_fact',
        'list_past_sessions',
        'get_session_summary',
      ],
    })).toEqual([]);
  });

  it('reports an advertised name without an implementation', () => {
    expect(unresolvedCatalogTools({
      descriptions: { missing_synthetic_tool: 'synthetic' },
      generatedNames,
    })).toEqual(['missing_synthetic_tool']);
  });

  it('does not expose an advertised tool missing from the registry', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const exposed = buildExposedTools(['missing_synthetic_tool'], ctx, {
        missing_synthetic_tool: undefined as never,
      });
      expect(exposed).not.toHaveProperty('missing_synthetic_tool');
    } finally {
      log.mockRestore();
    }
  });
});
