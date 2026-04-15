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
