import { describe, it, expect } from 'vitest';
import { SdkApiError } from '@uluops/sdk-core/errors';
import { isApiErrorLike } from '../../src/errors/index.js';

/**
 * The defect this guards: core and registry-sdk pin DIFFERENT exact versions of
 * @uluops/sdk-core, so two SdkApiError class objects coexist and `instanceof` is
 * always false for anything registry-sdk threw.
 *
 * A test that constructs core's OWN SdkApiError cannot detect that — both sides
 * point at the same class. So the load-bearing case below mints a FOREIGN error:
 * structurally identical, different class identity, exactly like the one that
 * crosses the real package boundary.
 */
describe('isApiErrorLike', () => {
  /** A different class object with the same shape — stands in for the other sdk-core copy. */
  class ForeignSdkApiError extends Error {
    constructor(
      public readonly statusCode: number,
      message: string,
      public readonly code?: string,
    ) {
      super(message);
      this.name = 'SdkApiError';
    }
  }

  it('accepts a FOREIGN api error that instanceof would reject (the actual defect)', () => {
    const foreign = new ForeignSdkApiError(402, 'subscription required', 'SUBSCRIPTION_REQUIRED');

    // Control built into the assertion: prove instanceof genuinely fails here,
    // so this test cannot pass for the wrong reason.
    expect(foreign instanceof SdkApiError).toBe(false);
    expect(isApiErrorLike(foreign)).toBe(true);
    if (isApiErrorLike(foreign)) expect(foreign.statusCode).toBe(402);
  });

  it('accepts a NotFoundError-shaped foreign error (404 arrives as a subclass, not base)', () => {
    const foreign = new ForeignSdkApiError(404, 'not found', 'NOT_FOUND');
    foreign.name = 'NotFoundError';
    expect(isApiErrorLike(foreign)).toBe(true);
  });

  it('accepts core’s own SdkApiError too (same-realm still works)', () => {
    expect(isApiErrorLike(new SdkApiError(401, 'unauthorized'))).toBe(true);
  });

  // Negative controls: the predicate must not simply accept everything.
  it('rejects a plain Error with no statusCode', () => {
    expect(isApiErrorLike(new Error('boom'))).toBe(false);
  });

  it('rejects null, undefined, and primitives', () => {
    for (const v of [null, undefined, 42, 'nope', true]) {
      expect(isApiErrorLike(v)).toBe(false);
    }
  });

  it('rejects an object whose statusCode is a string, not a number', () => {
    expect(isApiErrorLike({ statusCode: '402', message: 'x' })).toBe(false);
  });
});
