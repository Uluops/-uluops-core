import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'yaml';
import { RegistryClient } from '../../src/registry/RegistryClient.js';
import { IntegrityError } from '../../src/errors/index.js';
import { computeHash, computePromptHash } from '@uluops/sdk-core';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { Logger } from '@uluops/sdk-core';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const mockDefinitionsList = vi.fn();
const mockDefinitionsGet = vi.fn();
const mockRenderGet = vi.fn();

vi.mock('@uluops/registry-sdk', () => ({
  RegistryClient: vi.fn(() => ({
    definitions: { list: mockDefinitionsList, get: mockDefinitionsGet },
    render: { get: mockRenderGet },
  })),
}));

const baseConfig: ResolvedConfig = {
  apiKey: 'test-key',
  ai: { providers: { anthropic: { apiKey: 'k' } }, defaultProvider: 'anthropic' },
  registryUrl: 'https://registry.example.com/api',
  validationUrl: 'https://ops.example.com/api',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: true,
  timeout: 30000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
};

// A real-shaped agent YAML (interface present so config wiring engages).
const AGENT_YAML = yaml.stringify({
  agent: {
    interface: { name: 'pinned-agent', version: '1.0.0', domain: 'software', agentType: 'validator' },
    defaults: { model: 'opus', temperature: 0.2 },
  },
});
const RUNTIME_MD = '# Pinned Agent\n\nYou are a validator. Score the artifact.';
const AGENT_HASH = computeHash(AGENT_YAML);
const PROMPT_HASH = computePromptHash(RUNTIME_MD);

function remoteAgentDef(overrides: Record<string, unknown> = {}) {
  return {
    name: 'pinned-agent',
    type: 'agent',
    version: '1.0.0',
    hash: AGENT_HASH,
    yaml: AGENT_YAML,
    runtimeMd: RUNTIME_MD,
    promptHash: PROMPT_HASH,
    translatorVersion: '4.1.0',
    domain: 'software',
    agentType: 'validator',
    ...overrides,
  };
}

describe('RegistryClient — caller-pinned integrity (Phase 3)', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integrity-'));
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('frozen artifact', () => {
    it('executes def.runtimeMd as the prompt and does NOT live re-render', async () => {
      mockDefinitionsGet.mockResolvedValueOnce(remoteAgentDef());
      const client = new RegistryClient(baseConfig, noopLogger);

      const resolved = await client.resolve('pinned-agent', undefined, 'agent');

      expect((resolved.runtime as { prompt: string }).prompt).toBe(RUNTIME_MD);
      expect(resolved.promptHash).toBe(PROMPT_HASH);
      expect(resolved.translatorVersion).toBe('4.1.0');
      expect(mockRenderGet).not.toHaveBeenCalled();
    });

    it('wires runtime.defaults from the verified YAML (N2)', async () => {
      mockDefinitionsGet.mockResolvedValueOnce(remoteAgentDef());
      const client = new RegistryClient(baseConfig, noopLogger);

      const resolved = await client.resolve('pinned-agent', undefined, 'agent');
      const rt = resolved.runtime as { defaults?: { model?: string; temperature?: number } };
      expect(rt.defaults?.model).toBe('opus');
      expect(rt.defaults?.temperature).toBe(0.2);
    });

    it('falls back to live re-render only when runtimeMd is null (+ degradation)', async () => {
      mockDefinitionsGet.mockResolvedValueOnce(remoteAgentDef({ runtimeMd: null, promptHash: null }));
      mockRenderGet.mockResolvedValueOnce({ markdown: 'live rerender output' });
      const client = new RegistryClient(baseConfig, noopLogger);

      const resolved = await client.resolve('pinned-agent', undefined, 'agent');
      expect((resolved.runtime as { prompt: string }).prompt).toBe('live rerender output');
      expect(resolved.degradations).toContain('runtime:live-rerender-fallback');
      expect(resolved.promptHash).toBeUndefined();
      expect(mockRenderGet).toHaveBeenCalledOnce();
    });

    it('surfaces a clear error when runtimeMd is null AND re-render fails (N3)', async () => {
      mockDefinitionsGet.mockResolvedValueOnce(remoteAgentDef({ runtimeMd: null, promptHash: null }));
      mockRenderGet.mockRejectedValueOnce(new Error('422 UnprocessableEntity'));
      const client = new RegistryClient(baseConfig, noopLogger);

      await expect(client.resolve('pinned-agent', undefined, 'agent')).rejects.toThrow(/no frozen rendered|schema-stale/i);
    });

    it('flags prompt-hash-inconsistent when registry runtimeMd/promptHash disagree (belt-and-suspenders)', async () => {
      mockDefinitionsGet.mockResolvedValueOnce(remoteAgentDef({ promptHash: 'sha256:' + '0'.repeat(64) }));
      const client = new RegistryClient(baseConfig, noopLogger);

      const resolved = await client.resolve('pinned-agent', undefined, 'agent');
      expect(resolved.degradations).toContain('prompt-hash-inconsistent');
    });
  });

  describe('verifyPins', () => {
    it('passes when both pins match', async () => {
      mockDefinitionsGet.mockResolvedValueOnce(remoteAgentDef());
      const client = new RegistryClient(baseConfig, noopLogger);

      const resolved = await client.resolve('pinned-agent', undefined, 'agent', {
        expectedHash: AGENT_HASH,
        expectedPromptHash: PROMPT_HASH,
      });
      expect(resolved.name).toBe('pinned-agent');
    });

    it('throws IntegrityError(kind=yaml) on a bad YAML pin', async () => {
      mockDefinitionsGet.mockResolvedValueOnce(remoteAgentDef());
      const client = new RegistryClient(baseConfig, noopLogger);

      const err = await client.resolve('pinned-agent', undefined, 'agent', {
        expectedHash: 'sha256:' + '0'.repeat(64),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).kind).toBe('yaml');
    });

    it('throws IntegrityError(kind=prompt) on a bad prompt pin', async () => {
      mockDefinitionsGet.mockResolvedValueOnce(remoteAgentDef());
      const client = new RegistryClient(baseConfig, noopLogger);

      const err = await client.resolve('pinned-agent', undefined, 'agent', {
        expectedPromptHash: 'sha256:' + '0'.repeat(64),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).kind).toBe('prompt');
    });

    it('throws IntegrityError(kind=unavailable) for a prompt pin on a workflow', async () => {
      const wfYaml = yaml.stringify({ workflow: { interface: { name: 'wf', version: '1.0.0' }, orchestration: { phases: [] } } });
      mockDefinitionsGet.mockResolvedValueOnce({
        name: 'wf', type: 'workflow', version: '1.0.0',
        hash: computeHash(wfYaml), yaml: wfYaml,
        runtimeMd: '# wf', promptHash: computePromptHash('# wf'),
        translatorVersion: '3.0.0', domain: 'software',
      });
      const client = new RegistryClient(baseConfig, noopLogger);

      const err = await client.resolve('wf', undefined, 'workflow', {
        expectedPromptHash: computePromptHash('# wf'),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).kind).toBe('unavailable');
    });

    it('throws IntegrityError(kind=unavailable) for a prompt pin on a LOCAL agent', async () => {
      await fs.writeFile(path.join(tmpDir, 'pinned-agent.agent.yaml'), AGENT_YAML);
      mockRenderGet.mockResolvedValue({ markdown: 'local render' });
      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);

      const err = await client.resolve('pinned-agent', undefined, 'agent', {
        expectedPromptHash: PROMPT_HASH,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).kind).toBe('unavailable');
    });

    it('verifies a LOCAL agent YAML pin via the shared computeHash', async () => {
      await fs.writeFile(path.join(tmpDir, 'pinned-agent.agent.yaml'), AGENT_YAML);
      mockRenderGet.mockResolvedValue({ markdown: 'local render' });
      const client = new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger);

      const resolved = await client.resolve('pinned-agent', undefined, 'agent', { expectedHash: AGENT_HASH });
      expect(resolved.hash).toBe(AGENT_HASH);
    });
  });

  describe('cache path', () => {
    it('verifies pins on a cache HIT (unpinned-then-bad-pin throws)', async () => {
      mockDefinitionsGet.mockResolvedValueOnce(remoteAgentDef());
      const client = new RegistryClient(baseConfig, noopLogger);

      // First resolve: unpinned, populates cache.
      await client.resolve('pinned-agent', undefined, 'agent');
      // Second resolve: same id, BAD pin → must throw from the cache path
      // (definitions.get mocked only once, so a cache miss would error differently).
      const err = await client.resolve('pinned-agent', undefined, 'agent', {
        expectedHash: 'sha256:' + '0'.repeat(64),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).kind).toBe('yaml');
      expect(mockDefinitionsGet).toHaveBeenCalledOnce(); // proves it was a cache hit
    });
  });
});
