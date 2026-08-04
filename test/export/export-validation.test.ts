import { describe, expect, it } from 'vitest';
import { assertNoSecretMaterial, validatePortableExport } from '@access-control/application';
import { canonicalJson, jsonValueSchema } from '@access-control/domain';

const emptyEntities = {
  organizationSettings: [],
  subjects: [],
  externalIdentities: [],
  guestProfiles: [],
  platformRoleGrants: [],
  sourceGroups: [],
  sourceGroupMemberships: [],
  applications: [],
  applicationEntitlements: [],
  entitlementMappings: [],
  effectiveGrants: [],
  providerConnections: [],
  providerAccounts: [],
  provisioningTargets: [],
  provisioningStates: [],
  operationPlans: [],
  operationPlanChanges: [],
  auditEvents: [],
  exportRecords: [],
};

async function validExport() {
  const payload = {
    schemaVersion: '1.0.0' as const,
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities: emptyEntities,
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(jsonValueSchema.parse(payload))),
  );
  const checksum = `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
  return { ...payload, checksum };
}

describe('Portable export validation', () => {
  it('inventories every entity collection after checksum validation', async () => {
    const result = await validatePortableExport(await validExport());
    expect(result.entityCounts).toEqual(
      Object.fromEntries(Object.keys(emptyEntities).map((name) => [name, 0])),
    );
  });

  it('rejects checksum drift', async () => {
    await expect(
      validatePortableExport({
        ...(await validExport()),
        checksum: `sha256:${'f'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'export_checksum_mismatch' });
  });

  it('reports strict entity field violations and secret-like fields', async () => {
    const value = await validExport();
    await expect(
      validatePortableExport({ ...value, entities: { ...value.entities, unknown: [] } }),
    ).rejects.toBeDefined();
    await expect(
      validatePortableExport({
        ...value,
        entities: { ...value.entities, auditEvents: [{ privateKey: 'not-allowed' }] },
      }),
    ).rejects.toBeDefined();

    for (const candidate of [
      { apiKey: 'literal-secret' },
      { credentialRef: 'literal-secret' },
      { passwordRef: 'literal-secret' },
    ]) {
      expect(() => assertNoSecretMaterial(jsonValueSchema.parse(candidate))).toThrowError(
        expect.objectContaining({ code: 'secret_field_detected' }),
      );
    }
    expect(() =>
      assertNoSecretMaterial(jsonValueSchema.parse({ credentialRef: 'GITHUB_CREDENTIAL' })),
    ).not.toThrow();
  });
});
