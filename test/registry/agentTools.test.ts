/**
 * Declared agent tools reach the executor (tracker 38ce9462).
 *
 * AgentExecutor offers a shell only when `runtime.interface.tools` declares bash and the
 * operator allows it. RegistryClient built agent runtimes from prompt/defaults/config only and
 * never set `interface`, so from 611682e (2026-02-09) no registry-resolved agent was offered a
 * shell on any provider. The executor's own bash tests passed throughout because they hand-build
 * `runtime.interface: { tools: ['bash'] }` — a runtime the production path never produces.
 *
 * So these tests go through `RegistryClient.resolve` (remote and local paths) and hand the
 * RESOLVED definition to AgentExecutor. The corpus spells the tool `Bash` (98 v3 ADLs), and
 * operators write `bash`; both spellings are exercised.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'yaml';
import { RegistryClient } from '../../src/registry/RegistryClient.js';
import { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import { resolveConfig } from '../../src/client/UluOpsClient.js';
import type { AIProvider } from '../../src/ai/AIProvider.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { Logger } from '@uluops/sdk-core';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const mockDefinitionsGet = vi.fn();
const mockRenderGet = vi.fn();

vi.mock('@uluops/registry-sdk', () => ({
  RegistryClient: vi.fn(() => ({
    definitions: { list: vi.fn(), get: mockDefinitionsGet },
    render: { get: mockRenderGet },
  })),
}));

const baseConfig: ResolvedConfig = {
  apiKey: 'test-key',
  ai: { providers: { anthropic: { apiKey: 'k' } }, defaultProvider: 'anthropic' },
  registryUrl: 'https://registry.example.com/api',
  submissionUrl: 'https://ops.example.com/api',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: false,
  timeout: 30000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
  maxConcurrency: 8,
  allowStageSteps: false,
};

function agentYaml(tools: unknown): string {
  return yaml.stringify({
    agent: {
      interface: {
        name: 'shell-agent', version: '1.0.0', domain: 'software', agentType: 'validator',
        ...(tools === undefined ? {} : { tools }),
      },
      defaults: { model: 'sonnet' },
    },
  });
}

function remoteDef(tools: unknown) {
  return {
    name: 'shell-agent', type: 'agent', version: '1.0.0', hash: 'sha256:x', yaml: agentYaml(tools),
    runtimeMd: '# Shell agent\n\nValidate the target.', promptHash: null, translatorVersion: '4.1.0',
    domain: 'software', agentType: 'validator',
  };
}

async function resolveRemote(tools: unknown) {
  mockDefinitionsGet.mockResolvedValueOnce(remoteDef(tools));
  return new RegistryClient(baseConfig, noopLogger).resolve('shell-agent', undefined, 'agent');
}

const SHELL_TOOL = { bash: { description: 'stand-in provider shell tool', inputSchema: {}, execute: async () => '' } };

function mockAI(shell: unknown = SHELL_TOOL): AIProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text: JSON.stringify({ decision: 'PASS', score: 90, maxScore: 100, categories: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
      toolCallCount: 0, model: 'anthropic:claude-sonnet-4-6', provider: 'anthropic', steps: 1, finishReason: 'stop',
    }),
    resolveModel: vi.fn().mockResolvedValue({
      provider: 'anthropic', modelId: 'claude-sonnet-4-6', providerModelId: 'claude-sonnet-4-6', tier: 'premium',
      capabilities: { tools: true }, contextWindow: 200_000, registered: true, resolvedFrom: 'sonnet',
    }),
    createProviderShellTool: vi.fn().mockReturnValue(shell ?? undefined), // null = provider has no shell tool
  } as unknown as AIProvider;
}

/** The tool names generate() was actually called with — the delivery, not just the factory call. */
function toolsSentToModel(ai: AIProvider): string[] {
  const call = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { tools?: Record<string, unknown> };
  return Object.keys(call.tools ?? {});
}

async function shellOffered(tools: unknown, allowedTools: unknown, target: string): Promise<boolean> {
  const resolved = await resolveRemote(tools);
  const ai = mockAI();
  const config = { ...baseConfig, ...(allowedTools !== undefined ? { allowedTools } : {}) } as ResolvedConfig;
  const executor = new AgentExecutor(config, ai, noopLogger);
  await executor.execute(resolved, { target });
  // Delivery, not just the gate: the bash tool must be among the tools the model was given.
  return toolsSentToModel(ai).includes('bash');
}

describe('declared agent tools reach the runtime (38ce9462)', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
    await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export const x = 1;\n');
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('RegistryClient carries agent.interface.tools onto the runtime', () => {
    it('remote path: the declared tools are on runtime.interface.tools', async () => {
      const resolved = await resolveRemote(['Read', 'Grep', 'Glob', 'Bash']);
      expect((resolved.runtime as { interface?: { tools?: string[] } }).interface?.tools)
        .toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    });

    it('local path: the declared tools are on runtime.interface.tools', async () => {
      await fs.writeFile(path.join(tmpDir, 'local-shell.agent.yaml'), agentYaml(['Read', 'Bash']));
      mockRenderGet.mockRejectedValueOnce(new Error('offline'));
      const resolved = await new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger)
        .resolve('local-shell', undefined, 'agent');
      expect((resolved.runtime as { interface?: { tools?: string[] } }).interface?.tools).toEqual(['Read', 'Bash']);
    });

    it('an agent that declares no tools gets no interface (nothing is invented)', async () => {
      const resolved = await resolveRemote(undefined);
      expect((resolved.runtime as { interface?: unknown }).interface).toBeUndefined();
    });

    it('authored input: non-string entries are dropped, a non-array is ignored', async () => {
      const mixed = await resolveRemote(['Bash', 42, null, 'Read']);
      expect((mixed.runtime as { interface?: { tools?: string[] } }).interface?.tools).toEqual(['Bash', 'Read']);
      const scalar = await resolveRemote('Bash');
      expect((scalar.runtime as { interface?: unknown }).interface).toBeUndefined();
    });
  });

  describe('end to end: resolved definition → AgentExecutor offers the shell', () => {
    it("an agent declaring 'Bash' is offered the shell when the operator allows 'bash'", async () => {
      expect(await shellOffered(['Read', 'Bash'], ['bash'], tmpDir)).toBe(true);
    });

    it("the operator's spelling is case-insensitive too ('Bash' in allowedTools)", async () => {
      expect(await shellOffered(['bash'], ['Bash'], tmpDir)).toBe(true);
    });

    it('CONTROL — default (no allowedTools): an agent declaring Bash is NOT offered the shell', async () => {
      expect(await shellOffered(['Read', 'Bash'], undefined, tmpDir)).toBe(false);
    });

    it('CONTROL — allowedTools without bash: not offered', async () => {
      expect(await shellOffered(['Bash'], ['Read'], tmpDir)).toBe(false);
    });

    it('CONTROL — an agent that does not declare bash: not offered even when allowed', async () => {
      expect(await shellOffered(['Read', 'Grep'], ['bash'], tmpDir)).toBe(false);
    });

    it('local path: a local .agent.yaml declaring Bash reaches the model with a shell', async () => {
      await fs.writeFile(path.join(tmpDir, 'local-shell.agent.yaml'), agentYaml(['Read', 'Bash']));
      mockRenderGet.mockRejectedValueOnce(new Error('offline'));
      const resolved = await new RegistryClient({ ...baseConfig, localDefinitions: tmpDir }, noopLogger)
        .resolve('local-shell', undefined, 'agent');
      const ai = mockAI();
      await new AgentExecutor({ ...baseConfig, allowedTools: ['bash'] }, ai, noopLogger).execute(resolved, { target: tmpDir });
      expect(toolsSentToModel(ai)).toContain('bash');
    });

    it('allowedTools entries are trimmed (a programmatic " bash " allows bash)', async () => {
      expect(await shellOffered(['Bash'], [' bash '], tmpDir)).toBe(true);
    });

    it('a non-array allowedTools fails closed instead of throwing', async () => {
      expect(await shellOffered(['Bash'], 'bash', tmpDir)).toBe(false);
    });
  });

  describe('ULUOPS_ALLOWED_TOOLS reaches the same gate', () => {
    it('a mixed-case, Claude-Code-style list ("Read, Grep, Bash") allows bash', () => {
      const cfg = resolveConfig({ apiKey: 'ulr_test_00000000000000000000' }, { ULUOPS_ALLOWED_TOOLS: 'Read, Grep, Bash' });
      expect(cfg.allowedTools).toEqual(['Read', 'Grep', 'Bash']);
    });

    it('end to end: the env-parsed list offers the shell', async () => {
      const cfg = resolveConfig({ apiKey: 'ulr_test_00000000000000000000' }, { ULUOPS_ALLOWED_TOOLS: 'Read, Bash' });
      expect(await shellOffered(['Bash'], cfg.allowedTools, tmpDir)).toBe(true);
    });

    it('CONTROL — unset or empty env leaves the default (bash denied)', async () => {
      expect(resolveConfig({ apiKey: 'ulr_test_00000000000000000000' }, {}).allowedTools).toBeUndefined();
      expect(resolveConfig({ apiKey: 'ulr_test_00000000000000000000' }, { ULUOPS_ALLOWED_TOOLS: '' }).allowedTools).toBeUndefined();
      expect(await shellOffered(['Bash'], resolveConfig({ apiKey: 'ulr_test_00000000000000000000' }, {}).allowedTools, tmpDir)).toBe(false);
    });
  });

  describe('every outcome of a Bash declaration is logged', () => {
    async function runWith(allowedTools: string[] | undefined, shell: unknown) {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const resolved = await resolveRemote(['Bash']);
      await new AgentExecutor({ ...baseConfig, ...(allowedTools ? { allowedTools } : {}) }, mockAI(shell), logger)
        .execute(resolved, { target: tmpDir });
      const all = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map(c => String(c[0]));
      return { debug: all(logger.debug), info: all(logger.info), warn: all(logger.warn) };
    }

    it('offered: the user sees a warning (printed without debug) that shell access is active', async () => {
      const { warn } = await runWith(['bash'], SHELL_TOOL);
      expect(warn.some(m => m.includes('Shell access is active') && m.includes('no sandbox'))).toBe(true);
    });

    it('the notice is a warning once per executor, then info (a pipeline says it once)', async () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const executor = new AgentExecutor({ ...baseConfig, allowedTools: ['bash'] }, mockAI(), logger);
      await executor.execute(await resolveRemote(['Bash']), { target: tmpDir });
      await executor.execute(await resolveRemote(['Bash']), { target: tmpDir });
      const count = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter(c => String(c[0]).includes('Shell access is active')).length;
      expect(count(logger.warn)).toBe(1);
      expect(count(logger.info)).toBe(1);
    });

    it('allowed but the provider has no shell tool: a warning, not silence', async () => {
      const { warn } = await runWith(['bash'], null);
      expect(warn.some(m => m.includes('runs without a shell'))).toBe(true);
    });

    it('denied by the operator: a debug line names the setting', async () => {
      const { debug, info, warn } = await runWith(undefined, SHELL_TOOL);
      expect(debug.some(m => m.includes('ULUOPS_ALLOWED_TOOLS'))).toBe(true);
      expect([...info, ...warn].some(m => m.includes('Shell access is active') || m.includes('without a shell'))).toBe(false);
    });
  });
});
