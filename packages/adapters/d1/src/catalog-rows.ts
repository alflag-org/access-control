import {
  applicationEntitlementSchema,
  applicationSchema,
  effectiveGrantSchema,
  entitlementMappingSchema,
  type Application,
  type ApplicationEntitlement,
  type EffectiveGrant,
  type EntitlementMapping,
} from '@access-control/domain';
import {
  booleanValue,
  integer,
  jsonValue,
  optionalJsonValue,
  optionalText,
  text,
  type DatabaseRow,
} from './row-values';

export function mapApplication(row: DatabaseRow): Application {
  return applicationSchema.parse({
    id: text(row, 'id'),
    key: text(row, 'key'),
    name: text(row, 'name'),
    ...(optionalText(row, 'description') === undefined
      ? {}
      : { description: optionalText(row, 'description') }),
    category: text(row, 'category'),
    launchUrl: text(row, 'launch_url'),
    ...(optionalJsonValue(row, 'icon_json') === undefined
      ? {}
      : { icon: optionalJsonValue(row, 'icon_json') }),
    status: text(row, 'status'),
    visibility: text(row, 'visibility'),
    authentication: jsonValue(row, 'authentication_json'),
    provisioningMode: text(row, 'provisioning_mode'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}

export function mapApplicationEntitlement(row: DatabaseRow): ApplicationEntitlement {
  return applicationEntitlementSchema.parse({
    id: text(row, 'id'),
    applicationId: text(row, 'application_id'),
    key: text(row, 'key'),
    name: text(row, 'name'),
    ...(optionalText(row, 'description') === undefined
      ? {}
      : { description: optionalText(row, 'description') }),
    status: text(row, 'status'),
    requiresProvisioning: booleanValue(row, 'requires_provisioning'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}

export function mapEntitlementMapping(row: DatabaseRow): EntitlementMapping {
  return entitlementMappingSchema.parse({
    id: text(row, 'id'),
    sourceGroupId: text(row, 'source_group_id'),
    entitlementIds: jsonValue(row, 'entitlement_ids_json'),
    provisioningTargetIds: jsonValue(row, 'target_ids_json'),
    status: text(row, 'status'),
    ...(optionalText(row, 'valid_from') === undefined
      ? {}
      : { validFrom: optionalText(row, 'valid_from') }),
    ...(optionalText(row, 'valid_until') === undefined
      ? {}
      : { validUntil: optionalText(row, 'valid_until') }),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}

export function mapEffectiveGrant(row: DatabaseRow): EffectiveGrant {
  return effectiveGrantSchema.parse({
    id: text(row, 'id'),
    subjectId: text(row, 'subject_id'),
    sourceGroupId: text(row, 'source_group_id'),
    sourceGroupMembershipId: text(row, 'source_group_membership_id'),
    mappingId: text(row, 'mapping_id'),
    entitlementId: text(row, 'entitlement_id'),
    status: text(row, 'status'),
    calculatedAt: text(row, 'calculated_at'),
    ...(optionalText(row, 'valid_until') === undefined
      ? {}
      : { validUntil: optionalText(row, 'valid_until') }),
  });
}
