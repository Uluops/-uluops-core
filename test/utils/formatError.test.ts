import { describe, it, expect } from 'vitest';
import { formatErrorMessage } from '../../src/utils/formatError.js';

describe('formatErrorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(formatErrorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('extracts message from Error subclass', () => {
    expect(formatErrorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  it('returns string directly', () => {
    expect(formatErrorMessage('plain string error')).toBe('plain string error');
  });

  it('converts null to string', () => {
    expect(formatErrorMessage(null)).toBe('null');
  });

  it('converts undefined to string', () => {
    expect(formatErrorMessage(undefined)).toBe('undefined');
  });

  it('converts number to string', () => {
    expect(formatErrorMessage(42)).toBe('42');
  });

  it('converts object to string', () => {
    expect(formatErrorMessage({ code: 'ERR' })).toBe('[object Object]');
  });

  it('handles empty string', () => {
    expect(formatErrorMessage('')).toBe('');
  });
});
