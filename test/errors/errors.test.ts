import { describe, it, expect } from 'vitest';
import {
  UluOpsError,
  ExecutionError,
  PreflightError,
  ConfigurationError,
  ModelNotFoundError,
  CapabilityError,
  ValidationError,
  ValidationErrorCodes,
  WorkflowError,
  PipelineError,
  ParseError,
  SubscriptionRequiredError,
} from '../../src/errors/index.js';

describe('Error hierarchy', () => {
  it('UluOpsError is base class with correct name', () => {
    const err = new UluOpsError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UluOpsError');
    expect(err.message).toBe('test');
  });

  it('UluOpsError supports Error.cause', () => {
    const cause = new Error('root cause');
    const err = new UluOpsError('wrapped', { cause });
    expect(err.cause).toBe(cause);
  });

  it('all subclasses extend UluOpsError', () => {
    const classes = [
      new ExecutionError('e'),
      new PreflightError('p', 'check'),
      new ConfigurationError('c'),
      new ModelNotFoundError('m'),
      new CapabilityError('cap'),
      new ValidationError('v'),
      new WorkflowError('w', { partialResult: null }),
      new PipelineError('pipe'),
      new ParseError('parse', 'preview'),
      new SubscriptionRequiredError('sub', 'pro', 'free'),
    ];

    for (const err of classes) {
      expect(err).toBeInstanceOf(UluOpsError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('each subclass has its own .name', () => {
    expect(new ExecutionError('e').name).toBe('ExecutionError');
    expect(new PreflightError('p', 'c').name).toBe('PreflightError');
    expect(new ConfigurationError('c').name).toBe('ConfigurationError');
    expect(new ModelNotFoundError('m').name).toBe('ModelNotFoundError');
    expect(new CapabilityError('cap').name).toBe('CapabilityError');
    expect(new ValidationError('v').name).toBe('ValidationError');
    expect(new WorkflowError('w', { partialResult: null }).name).toBe('WorkflowError');
    expect(new PipelineError('pipe').name).toBe('PipelineError');
    expect(new ParseError('parse', 'p').name).toBe('ParseError');
    expect(new SubscriptionRequiredError('s', 'pro', 'free').name).toBe('SubscriptionRequiredError');
  });
});

describe('ExecutionError', () => {
  it('exposes partialResult', () => {
    const partial = { score: 42 };
    const err = new ExecutionError('fail', partial);
    expect(err.partialResult).toBe(partial);
  });

  it('partialResult defaults to undefined', () => {
    const err = new ExecutionError('fail');
    expect(err.partialResult).toBeUndefined();
  });

  it('supports Error.cause', () => {
    const cause = new Error('original');
    const err = new ExecutionError('wrapped', undefined, { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('PreflightError', () => {
  it('exposes check and details', () => {
    const details = { command: 'git status' };
    const err = new PreflightError('check failed', 'git', details);
    expect(err.check).toBe('git');
    expect(err.details).toEqual(details);
  });

  it('details defaults to undefined', () => {
    const err = new PreflightError('check failed', 'git');
    expect(err.details).toBeUndefined();
  });
});

describe('ValidationError', () => {
  it('exposes code', () => {
    const err = new ValidationError('not found', ValidationErrorCodes.NOT_FOUND);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('code defaults to VALIDATION_ERROR', () => {
    const err = new ValidationError('generic');
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});

describe('WorkflowError', () => {
  it('exposes context with partialResult', () => {
    const partial = { phases: [] };
    const err = new WorkflowError('gate failed', { partialResult: partial });
    expect(err.context.partialResult).toBe(partial);
  });
});

describe('ParseError', () => {
  it('exposes contentPreview', () => {
    const err = new ParseError('no json', 'some raw text...');
    expect(err.contentPreview).toBe('some raw text...');
  });
});

describe('SubscriptionRequiredError', () => {
  it('exposes requiredTier and currentTier', () => {
    const err = new SubscriptionRequiredError('upgrade needed', 'plus', 'free');
    expect(err.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(err.requiredTier).toBe('plus');
    expect(err.currentTier).toBe('free');
    expect(err.definition).toBeUndefined();
    expect(err.upgradeUrl).toBeUndefined();
  });

  it('exposes definition and upgradeUrl when provided', () => {
    const def = { type: 'agent', name: 'socrates-explorer', displayName: 'Socrates Explorer' };
    const err = new SubscriptionRequiredError(
      'requires hobbyist',
      'hobbyist',
      'free',
      def,
      'https://registry.uluops.ai/orgs/test/settings/billing',
    );
    expect(err.definition).toEqual(def);
    expect(err.upgradeUrl).toBe('https://registry.uluops.ai/orgs/test/settings/billing');
  });

  it('toJSON includes all fields', () => {
    const def = { type: 'agent', name: 'test-agent' };
    const err = new SubscriptionRequiredError('msg', 'pro', 'hobbyist', def, 'https://example.com/upgrade');
    const json = err.toJSON();
    expect(json.name).toBe('SubscriptionRequiredError');
    expect(json.message).toBe('msg');
    expect(json.requiredTier).toBe('pro');
    expect(json.currentTier).toBe('hobbyist');
    expect(json.definition).toEqual(def);
    expect(json.upgradeUrl).toBe('https://example.com/upgrade');
  });

  it('toJSON omits undefined optional fields', () => {
    const err = new SubscriptionRequiredError('msg', 'pro', 'free');
    const json = err.toJSON();
    expect(json.requiredTier).toBe('pro');
    expect(json.currentTier).toBe('free');
    expect('definition' in json).toBe(false);
    expect('upgradeUrl' in json).toBe(false);
  });

  it('tierComparison returns gap between current and required', () => {
    const err = new SubscriptionRequiredError('msg', 'pro', 'free');
    expect(err.tierComparison).toEqual({ current: 'free', required: 'pro', gap: 3 });
  });

  it('tierComparison gap is 1 for adjacent tiers', () => {
    const err = new SubscriptionRequiredError('msg', 'hobbyist', 'free');
    expect(err.tierComparison.gap).toBe(1);
  });

  it('trackedUpgradeUrl appends source param', () => {
    const err = new SubscriptionRequiredError('msg', 'pro', 'free', undefined, 'https://example.com/billing');
    expect(err.trackedUpgradeUrl('sdk')).toBe('https://example.com/billing?source=sdk');
    expect(err.trackedUpgradeUrl('mcp')).toBe('https://example.com/billing?source=mcp');
    expect(err.trackedUpgradeUrl('cli')).toBe('https://example.com/billing?source=cli');
  });

  it('trackedUpgradeUrl appends with & when URL has existing params', () => {
    const err = new SubscriptionRequiredError('msg', 'pro', 'free', undefined, 'https://example.com/billing?feature=test');
    expect(err.trackedUpgradeUrl('sdk')).toBe('https://example.com/billing?feature=test&source=sdk');
  });

  it('trackedUpgradeUrl returns undefined when no upgradeUrl', () => {
    const err = new SubscriptionRequiredError('msg', 'pro', 'free');
    expect(err.trackedUpgradeUrl('cli')).toBeUndefined();
  });

  it('toJSON includes tierComparison', () => {
    const err = new SubscriptionRequiredError('msg', 'plus', 'hobbyist');
    const json = err.toJSON();
    expect(json.tierComparison).toEqual({ current: 'hobbyist', required: 'plus', gap: 1 });
  });
});
