import { createOrganizationSettingsCandidate } from '@access-control/domain';
import type {
  RuntimeConfigurationManifest,
  RuntimeConfigurationSnapshot,
} from '@access-control/config';

const time = '2026-01-01T00:00:00.000Z';

export function emptyConfigurationManifest(): RuntimeConfigurationManifest {
  return {
    schemaVersion: 1,
    organization: {
      name: 'Example Organization',
      title: 'Example Organization',
      maxPlanChanges: 20,
    },
    directorySources: [],
    applications: [],
    providerConnections: [],
    provisioningTargets: [],
    mappings: [],
  };
}

export function emptyConfigurationSnapshot(): RuntimeConfigurationSnapshot {
  return {
    organization: createOrganizationSettingsCandidate({
      id: 'organization',
      organizationName: 'Example Organization',
      title: 'Example Organization',
      maxPlanChanges: 20,
      revision: 1,
      createdAt: time,
      updatedAt: time,
      createdBy: 'subject:admin',
      updatedBy: 'subject:admin',
    }),
    directorySources: [],
    applications: [],
    entitlements: [],
    providerConnections: [],
    provisioningTargets: [],
    mappings: [],
    sourceGroups: [],
    sourceGroupMemberships: [],
    subjects: [],
    externalIdentities: [],
    guestProfiles: [],
  };
}
