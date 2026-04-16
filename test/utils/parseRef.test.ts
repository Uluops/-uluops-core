import { describe, it, expect } from 'vitest';
import { parseRef } from '../../src/utils/parseRef.js';

describe('parseRef', () => {
  describe('name only (no version)', () => {
    it('returns name with undefined version', () => {
      expect(parseRef('code-validator')).toEqual(['code-validator', undefined]);
    });

    it('handles single-word names', () => {
      expect(parseRef('validate')).toEqual(['validate', undefined]);
    });

    it('handles names with hyphens and numbers', () => {
      expect(parseRef('my-agent-v2')).toEqual(['my-agent-v2', undefined]);
    });
  });

  describe('name@version', () => {
    it('splits on @ into name and version', () => {
      expect(parseRef('code-validator@1.0.0')).toEqual(['code-validator', '1.0.0']);
    });

    it('handles semver with pre-release tag', () => {
      expect(parseRef('agent@2.0.0-beta.1')).toEqual(['agent', '2.0.0-beta.1']);
    });

    it('treats @latest as unversioned (resolves latest published)', () => {
      expect(parseRef('agent@latest')).toEqual(['agent', undefined]);
    });
  });

  describe('edge cases', () => {
    it('returns empty name with undefined version for empty string', () => {
      expect(parseRef('')).toEqual(['', undefined]);
    });

    it('treats trailing @ as empty version → undefined', () => {
      // ref.slice(atIndex + 1) is '', || undefined → undefined
      expect(parseRef('agent@')).toEqual(['agent', undefined]);
    });

    it('splits on first @ only when multiple @ present', () => {
      expect(parseRef('agent@1.0.0@extra')).toEqual(['agent', '1.0.0@extra']);
    });

    it('handles @ at the start (empty name)', () => {
      expect(parseRef('@1.0.0')).toEqual(['', '1.0.0']);
    });

    it('handles whitespace in name', () => {
      expect(parseRef(' spaced ')).toEqual([' spaced ', undefined]);
    });

    it('handles whitespace around @', () => {
      expect(parseRef('agent @1.0.0')).toEqual(['agent ', '1.0.0']);
    });
  });
});
