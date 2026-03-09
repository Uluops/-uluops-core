import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'yaml';
import { RegistryClient } from '../../src/registry/RegistryClient.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { Logger } from '@uluops/sdk-core';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// Module-level mock references (vi.mock is hoisted, so these are safe)
const mockDefinitionsList = vi.fn();
const mockDefinitionsGet = vi.fn();
const mockRenderGet = vi.fn();

vi.mock('@uluops/registry-sdk', () => ({
  RegistryClient: vi.fn(() => ({
    definitions: {
      list: mockDefinitionsList,
      get: mockDefinitionsGet,
    },
    render: {
      get: mockRenderGet,
    },
  })),
}));

function getMocks() {
  return {
    definitions: { list: mockDefinitionsList, get: mockDefinitionsGet },
    render: { get: mockRenderGet },
  };
}

const baseConfig: ResolvedConfig = {
  apiKey: 'test-key',
  ai: {
    providers: { anthropic: { apiKey: 'test-anthropic-key' } },
    defaultProvider: 'anthropic',
  },
  registryUrl: 'https://registry.example.com/api',
  validationUrl: 'https://ops.example.com/api',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: true,
  timeout: 30000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
};

describe('RegistryClient', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'regclient-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Local Resolution
  // ─────────────────────────────────────────────────────────────────────────────

  describe('resolve (local)', () => {
    it('resolves agent definition from local files', async () => {
      const agentYaml = yaml.stringify({
        agent: {
          interface: {
            name: 'test-validator',
            version: '1.0.0',
            domain: 'software',
            agentType: 'validator',
          },
          behavior: {
            role: 'A code reviewer',
            expertise: ['TypeScript', 'testing'],
          },
          output: {
            format: 'JSON',
          },
        },
      });

      await fs.writeFile(path.join(tmpDir, 'test-validator.agent.yaml'), agentYaml);

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);
      const result = await client.resolve('test-validator');

      expect(result.type).toBe('agent');
      expect(result.name).toBe('test-validator');
      expect(result.version).toBe('1.0.0');
      expect(result.hash).toBe('');
      expect(result.yaml).toBe(agentYaml);
      expect(result.domain).toBe('software');
      expect(result.agentType).toBe('validator');
    });

    it('resolves command definition from local files', async () => {
      const cmdYaml = yaml.stringify({
        command: {
          interface: {
            name: 'code-validator',
            version: '2.0.0',
            domain: 'software',
          },
          agents: ['test-validator@1.0.0'],
          execution: {
            model: { default: 'sonnet' },
            thresholds: { pass: 75 },
          },
        },
      });

      await fs.writeFile(path.join(tmpDir, 'code-validator.command.yaml'), cmdYaml);

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);
      const result = await client.resolve('code-validator', undefined, 'command');

      expect(result.type).toBe('command');
      expect(result.name).toBe('code-validator');
      expect(result.version).toBe('2.0.0');
    });

    it('resolves from subdirectory (agents/)', async () => {
      await fs.mkdir(path.join(tmpDir, 'agents'));

      const agentYaml = yaml.stringify({
        agent: {
          interface: {
            name: 'sub-agent',
            version: '1.0.0',
            domain: 'general',
            agentType: 'executor',
          },
          behavior: {
            role: 'An executor',
            expertise: ['tasks'],
          },
          output: { format: 'text' },
        },
      });

      await fs.writeFile(path.join(tmpDir, 'agents', 'sub-agent.agent.yaml'), agentYaml);

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);
      const result = await client.resolve('sub-agent', undefined, 'agent');

      expect(result.type).toBe('agent');
      expect(result.name).toBe('sub-agent');
      expect(result.agentType).toBe('executor');
    });

    it('filters candidates by type when type is specified', async () => {
      // Create both agent and command with same base name
      await fs.writeFile(
        path.join(tmpDir, 'shared.agent.yaml'),
        yaml.stringify({ agent: { interface: { name: 'shared', version: '1.0.0', agentType: 'validator' }, behavior: { role: 'x', expertise: ['y'] }, output: { format: 'JSON' } } }),
      );
      await fs.writeFile(
        path.join(tmpDir, 'shared.command.yaml'),
        yaml.stringify({ command: { interface: { name: 'shared', version: '2.0.0' }, agents: ['x'], execution: { model: { default: 'sonnet' } } } }),
      );

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);

      const agent = await client.resolve('shared', undefined, 'agent');
      expect(agent.type).toBe('agent');
      expect(agent.version).toBe('1.0.0');

      client.clearCache();

      const cmd = await client.resolve('shared', undefined, 'command');
      expect(cmd.type).toBe('command');
      expect(cmd.version).toBe('2.0.0');
    });

    it('returns null when local file not found, falls through to remote', async () => {
      const mocks = getMocks();
      mocks.definitions.list.mockResolvedValueOnce({
        definitions: [{ name: 'remote-agent', type: 'agent', version: '1.0.0', status: 'published', displayName: 'Remote Agent', description: 'test', domain: 'software', agentType: 'validator' }],
        total: 1,
      });
      mocks.definitions.get.mockResolvedValueOnce({
        name: 'remote-agent',
        type: 'agent',
        version: '1.0.0',
        hash: 'sha256:abc',
        yaml: 'agent: {}',
        domain: 'software',
        agentType: 'validator',
      });
      mocks.render.get.mockResolvedValueOnce({ markdown: 'rendered prompt' });

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);
      const result = await client.resolve('remote-agent');

      expect(result.name).toBe('remote-agent');
      expect(mocks.definitions.list).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Caching
  // ─────────────────────────────────────────────────────────────────────────────

  describe('caching', () => {
    it('caches resolved definitions', async () => {
      const agentYaml = yaml.stringify({
        agent: {
          interface: { name: 'cached', version: '1.0.0', agentType: 'validator' },
          behavior: { role: 'x', expertise: ['y'] },
          output: { format: 'JSON' },
        },
      });
      await fs.writeFile(path.join(tmpDir, 'cached.agent.yaml'), agentYaml);

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);

      const first = await client.resolve('cached');
      const second = await client.resolve('cached');

      expect(first).toBe(second); // Same reference = cached
    });

    it('clearCache invalidates cached entries', async () => {
      const agentYaml = yaml.stringify({
        agent: {
          interface: { name: 'cached2', version: '1.0.0', agentType: 'validator' },
          behavior: { role: 'x', expertise: ['y'] },
          output: { format: 'JSON' },
        },
      });
      await fs.writeFile(path.join(tmpDir, 'cached2.agent.yaml'), agentYaml);

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);

      const first = await client.resolve('cached2');
      client.clearCache();
      const second = await client.resolve('cached2');

      expect(first).not.toBe(second); // Different references after cache clear
      expect(first.hash).toBe(second.hash); // But same content
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Remote Resolution
  // ─────────────────────────────────────────────────────────────────────────────

  describe('resolve (remote)', () => {
    it('resolves from remote when no local definitions configured', async () => {
      const mocks = getMocks();
      mocks.definitions.list.mockResolvedValueOnce({
        definitions: [{ name: 'remote-cmd', type: 'command', version: '3.0.0', status: 'published', displayName: 'Remote', description: 'test', domain: 'software' }],
        total: 1,
      });
      mocks.definitions.get.mockResolvedValueOnce({
        name: 'remote-cmd',
        type: 'command',
        version: '3.0.0',
        hash: 'sha256:def',
        yaml: yaml.stringify({ command: {} }),
        domain: 'software',
      });
      mocks.render.get.mockResolvedValueOnce({ markdown: '# Command prompt' });

      const client = new RegistryClient(baseConfig, noopLogger); // No localDefinitions
      const result = await client.resolve('remote-cmd');

      expect(result.name).toBe('remote-cmd');
      expect(result.type).toBe('command');
      expect(result.version).toBe('3.0.0');
    });

    it('skips type search when type is provided', async () => {
      const mocks = getMocks();
      mocks.definitions.get.mockResolvedValueOnce({
        name: 'typed-agent',
        type: 'agent',
        version: '1.0.0',
        hash: 'sha256:ghi',
        yaml: yaml.stringify({ agent: {} }),
        domain: 'general',
        agentType: 'validator',
      });
      mocks.render.get.mockResolvedValueOnce({ markdown: 'prompt' });

      const client = new RegistryClient(baseConfig, noopLogger);
      await client.resolve('typed-agent', undefined, 'agent');

      // Should NOT have called list since type was provided
      expect(mocks.definitions.list).not.toHaveBeenCalled();
      expect(mocks.definitions.get).toHaveBeenCalledWith('agent', 'typed-agent', undefined, {
        includeYaml: true,
        includeRuntime: true,
      });
    });

    it('throws when definition not found in registry', async () => {
      const mocks = getMocks();
      mocks.definitions.list.mockResolvedValueOnce({ definitions: [], total: 0 });

      const client = new RegistryClient(baseConfig, noopLogger);
      await expect(client.resolve('nonexistent')).rejects.toThrow('not found in registry');
    });

    it('throws when multiple definitions found without type hint', async () => {
      const mocks = getMocks();
      mocks.definitions.list.mockResolvedValueOnce({
        definitions: [
          { name: 'ambiguous', type: 'agent' },
          { name: 'ambiguous', type: 'command' },
        ],
        total: 2,
      });

      const client = new RegistryClient(baseConfig, noopLogger);
      await expect(client.resolve('ambiguous')).rejects.toThrow('Multiple definitions');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // list()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('lists local definitions', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'my-agent.agent.yaml'),
        yaml.stringify({ agent: { interface: { name: 'my-agent', version: '1.0.0', domain: 'software', agentType: 'validator' } } }),
      );

      const mocks = getMocks();
      mocks.definitions.list.mockResolvedValueOnce({ definitions: [], total: 0 });

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);
      const results = await client.list();

      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe('my-agent');
      expect(results[0]!.status).toBe('draft');
    });

    it('merges local and remote, preferring local', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'overlap.agent.yaml'),
        yaml.stringify({ agent: { interface: { name: 'overlap', version: '1.0.0', domain: 'software' } } }),
      );

      const mocks = getMocks();
      mocks.definitions.list.mockResolvedValueOnce({
        definitions: [
          { name: 'overlap', type: 'agent', version: '2.0.0', status: 'published', displayName: 'Overlap', description: 'remote', domain: 'software' },
          { name: 'remote-only', type: 'command', version: '1.0.0', status: 'published', displayName: 'Remote Only', description: 'remote', domain: 'general' },
        ],
        total: 2,
      });

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);
      const results = await client.list();

      expect(results.length).toBe(2);
      // Local version should be preferred
      const overlap = results.find(r => r.name === 'overlap');
      expect(overlap!.version).toBe('1.0.0');
      expect(overlap!.status).toBe('draft');
      // Remote-only should be included
      expect(results.find(r => r.name === 'remote-only')).toBeDefined();
    });

    it('filters by type', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'a.agent.yaml'),
        yaml.stringify({ agent: { interface: { name: 'a', version: '1.0.0' } } }),
      );
      await fs.writeFile(
        path.join(tmpDir, 'b.command.yaml'),
        yaml.stringify({ command: { interface: { name: 'b', version: '1.0.0' } } }),
      );

      const mocks = getMocks();
      mocks.definitions.list.mockResolvedValueOnce({ definitions: [], total: 0 });

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);
      const results = await client.list({ type: 'agent' });

      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe('a');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Local Rendering
  // ─────────────────────────────────────────────────────────────────────────────

  describe('local rendering', () => {
    it('renders agent prompt from ADL v3 definition', async () => {
      const agentYaml = yaml.stringify({
        agent: {
          interface: {
            name: 'render-test',
            version: '1.0.0',
            displayName: 'Render Test',
            description: 'Test agent for rendering',
            agentType: 'validator',
            domain: 'software',
          },
          defaults: { model: 'sonnet', timeout: 300000 },
          mission: {
            opener: 'You are a strict TypeScript code validator.',
            outcome_framing: 'Provide a PASS/FAIL decision.',
            stakes: 'Issues missed here reach production.',
            role_boundaries: ['Focus on code quality only'],
          },
          scoring: {
            maxScore: 100,
            categories: [
              {
                id: 'quality',
                name: 'Code Quality',
                weight: 50,
                criteria: [
                  { id: 'readability', name: 'Readability', points: 25 },
                  { id: 'maintainability', name: 'Maintainability', points: 25 },
                ],
              },
            ],
          },
          decisions: {
            vocabulary: { positive: 'PASS', negative: 'FAIL', conditional: null },
            thresholds: [
              { decision: 'positive', min_score: 70, label: 'Passing' },
              { decision: 'negative', max_score: 69, label: 'Failing' },
            ],
          },
          auto_fail: {
            conditions: [
              { id: 'af1', display_id: 'AF-001', name: 'Security vulnerability', severity: 'critical', detection: { method: 'semantic' } },
            ],
          },
          output: { format: 'markdown' },
        },
      });
      await fs.writeFile(path.join(tmpDir, 'render-test.agent.yaml'), agentYaml);

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);
      const result = await client.resolve('render-test');

      const runtime = result.runtime as { prompt: string; defaults: { model: string; timeout: number }; config: Record<string, unknown> };
      // Prompt is YAML content (fallback when registry API unavailable)
      expect(runtime.prompt).toContain('strict TypeScript code validator');
      expect(runtime.prompt).toContain('PASS/FAIL decision');
      expect(runtime.prompt).toContain('Code Quality');
      expect(runtime.prompt).toContain('Readability');
      expect(runtime.prompt).toContain('AF-001');
      // Defaults populated from agent.defaults section
      expect(runtime.defaults.model).toBe('sonnet');
      expect(runtime.defaults.timeout).toBe(300000);
      // Config populated from scoring
      expect(runtime.config.maxScore).toBe(100);
      expect(runtime.config.threshold).toBe(70);
    });

    it('renders command prompt with agent refs', async () => {
      const cmdYaml = yaml.stringify({
        command: {
          interface: { name: 'cmd-render', version: '1.0.0' },
          agents: ['agent-a@1.0.0', 'agent-b@2.0.0'],
          execution: { model: { default: 'opus' }, thresholds: { pass: 80 } },
        },
      });
      await fs.writeFile(path.join(tmpDir, 'cmd-render.command.yaml'), cmdYaml);

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);
      const result = await client.resolve('cmd-render', undefined, 'command');

      const runtime = result.runtime as { prompt: string };
      // Prompt is YAML content (fallback when registry API unavailable)
      expect(runtime.prompt).toContain('cmd-render');
      expect(runtime.prompt).toContain('agent-a@1.0.0');
      expect(runtime.prompt).toContain('agent-b@2.0.0');
      expect(runtime.prompt).toContain('opus');
    });
  });
});
