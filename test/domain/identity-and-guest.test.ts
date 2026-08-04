import { describe, expect, it } from 'vitest';
import {
  createExternalIdentityCandidate,
  createSubjectCandidate,
  guestProfileSchema,
} from '@access-control/domain';
import {
  FIXTURE_TIME,
  activeGuest,
  googleIdentity,
  memberSubject,
} from '../fixtures/domain-fixtures';

describe('Subject and external identity invariants', () => {
  it('rejects unknown fields in strict domain records', () => {
    expect(() => memberSubject({ unexpected: true })).toThrow();
    expect(() => googleIdentity({ credential: 'must-not-exist' })).toThrow();
  });

  it.each([
    ['human', 'service_account'],
    ['human', 'automation'],
    ['service', 'member'],
    ['workload', 'managed_guest'],
  ] as const)('rejects kind %s with classification %s', (kind, classification) => {
    expect(() => memberSubject({ kind, classification })).toThrow(/classification/i);
  });

  it('keeps the provider issuer and immutable subject separate from email metadata', () => {
    const identity = createExternalIdentityCandidate({
      ...googleIdentity(),
      email: 'new-address@example.org',
    });
    expect(identity.providerSubject).toBe('google-user-1');
    expect(identity.issuer).toBe('urn:google-directory:customer:example-customer');
    expect(identity.email).toBe('new-address@example.org');
  });

  it('rejects a service classification on a human candidate directly', () => {
    expect(() =>
      createSubjectCandidate({ ...memberSubject(), classification: 'service_account' }),
    ).toThrow();
  });
});

describe('Managed Guest sponsor and expiration invariants', () => {
  it('requires a distinct sponsor', () => {
    expect(() => activeGuest({ sponsorSubjectId: 'subject:member' })).toThrow(/sponsor itself/i);
  });

  it('requires expiration after valid-from', () => {
    expect(() => activeGuest({ expiresAt: '2025-11-30T00:00:00.000Z' })).toThrow(/expiration/i);
  });

  it('rejects unknown guest metadata', () => {
    expect(
      guestProfileSchema.safeParse({ ...activeGuest(), externalOtpSecret: 'not-allowed' }).success,
    ).toBe(false);
  });

  it('accepts a bounded, sponsored record', () => {
    const guest = activeGuest({ createdAt: FIXTURE_TIME });
    expect(guest.status).toBe('active');
    expect(Date.parse(guest.expiresAt)).toBeGreaterThan(Date.parse(guest.validFrom));
  });
});
