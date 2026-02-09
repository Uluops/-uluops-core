import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'yaml';
import { RegistryClient } from '../../src/registry/RegistryClient.js';
import type { ResolvedConfig } from '../../src/types/config.js';

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
  registryUrl: 'https://registry.example.com/api',
  validationUrl: 'https://ops.example.com/api',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: true,
  hashVerificationEnabled: false,
  timeout: 30000,
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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });
      const result = await client.resolve('test-validator');

      expect(result.type).toBe('agent');
      expect(result.name).toBe('test-validator');
      expect(result.version).toBe('1.0.0');
      expect(result.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });
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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });
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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });

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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });
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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });

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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });

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

      const client = new RegistryClient(baseConfig); // No localDefinitions
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

      const client = new RegistryClient(baseConfig);
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

      const client = new RegistryClient(baseConfig);
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

      const client = new RegistryClient(baseConfig);
      await expect(client.resolve('ambiguous')).rejects.toThrow('Multiple definitions');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Hash Verification
  // ─────────────────────────────────────────────────────────────────────────────

  describe('hash verification', () => {
    it('verifies hash when enabled and hash matches', async () => {
      const mocks = getMocks();
      const yamlContent = yaml.stringify({ agent: { interface: { name: 'hashed' } } });
      // Compute the expected hash the same way the client does
      const normalized = yaml.stringify(yaml.parse(yamlContent), { sortMapEntries: true });
      const crypto = await import('node:crypto');
      const expectedHash = 'sha256:' + crypto.createHash('sha256').update(normalized).digest('hex');

      mocks.definitions.get.mockResolvedValueOnce({
        name: 'hashed',
        type: 'agent',
        version: '1.0.0',
        hash: expectedHash,
        yaml: yamlContent,
        domain: 'general',
      });
      mocks.render.get.mockResolvedValueOnce({ markdown: 'prompt' });

      const client = new RegistryClient({ ...baseConfig, hashVerificationEnabled: true });
      // Should not throw
      const result = await client.resolve('hashed', undefined, 'agent');
      expect(result.hash).toBe(expectedHash);
    });

    it('throws HashVerificationError when hash mismatch', async () => {
      const mocks = getMocks();
      mocks.definitions.get.mockResolvedValueOnce({
        name: 'tampered',
        type: 'agent',
        version: '1.0.0',
        hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        yaml: yaml.stringify({ agent: { tampered: true } }),
        domain: 'general',
      });
      mocks.render.get.mockResolvedValueOnce({ markdown: 'prompt' });

      const client = new RegistryClient({ ...baseConfig, hashVerificationEnabled: true });
      await expect(client.resolve('tampered', undefined, 'agent')).rejects.toThrow('Hash mismatch');
    });

    it('skips hash verification when disabled', async () => {
      const mocks = getMocks();
      mocks.definitions.get.mockResolvedValueOnce({
        name: 'no-check',
        type: 'agent',
        version: '1.0.0',
        hash: 'sha256:wrong',
        yaml: yaml.stringify({ agent: {} }),
        domain: 'general',
      });
      mocks.render.get.mockResolvedValueOnce({ markdown: 'prompt' });

      const client = new RegistryClient({ ...baseConfig, hashVerificationEnabled: false });
      // Should not throw despite wrong hash
      const result = await client.resolve('no-check', undefined, 'agent');
      expect(result.name).toBe('no-check');
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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });
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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });
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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });
      const results = await client.list({ type: 'agent' });

      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe('a');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Local Rendering
  // ─────────────────────────────────────────────────────────────────────────────

  describe('local rendering', () => {
    it('renders agent prompt with role and expertise', async () => {
      const agentYaml = yaml.stringify({
        agent: {
          interface: { name: 'render-test', version: '1.0.0', agentType: 'validator' },
          behavior: {
            role: 'A TypeScript expert',
            expertise: ['TypeScript', 'Node.js'],
            methodology: 'Review code line by line.',
            categories: [
              { name: 'Quality', weight: 50, criteria: ['readability', 'maintainability'] },
            ],
          },
          output: { format: 'JSON' },
        },
      });
      await fs.writeFile(path.join(tmpDir, 'render-test.agent.yaml'), agentYaml);

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });
      const result = await client.resolve('render-test');

      const runtime = result.runtime as { prompt: string };
      expect(runtime.prompt).toContain('You are A TypeScript expert');
      expect(runtime.prompt).toContain('TypeScript, Node.js');
      expect(runtime.prompt).toContain('Review code line by line');
      expect(runtime.prompt).toContain('Quality (weight: 50)');
      expect(runtime.prompt).toContain('JSON format');
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

      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir });
      const result = await client.resolve('cmd-render', undefined, 'command');

      const runtime = result.runtime as { prompt: string };
      expect(runtime.prompt).toContain('[Command: cmd-render]');
      expect(runtime.prompt).toContain('agent-a@1.0.0, agent-b@2.0.0');
      expect(runtime.prompt).toContain('opus');
      expect(runtime.prompt).toContain('80');
    });
  });
});
