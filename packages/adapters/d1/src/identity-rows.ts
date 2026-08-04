import {
  externalIdentitySchema,
  guestProfileSchema,
  organizationSettingsSchema,
  platformRoleGrantSchema,
  subjectSchema,
  type ExternalIdentity,
  type GuestProfile,
  type OrganizationSettings,
  type PlatformRoleGrant,
  type Subject,
} from '@access-control/domain';
import { booleanValue, integer, optionalText, text, type DatabaseRow } from './row-values';

export function mapOrganizationSettings(row: DatabaseRow): OrganizationSettings {
  return organizationSettingsSchema.parse({
    id: text(row, 'id'),
    organizationName: text(row, 'organization_name'),
    title: text(row, 'title'),
    ...(optionalText(row, 'support_url') === undefined
      ? {}
      : { supportUrl: optionalText(row, 'support_url') }),
    ...(optionalText(row, 'brand_mark_url') === undefined
      ? {}
      : { brandMarkUrl: optionalText(row, 'brand_mark_url') }),
    maxPlanChanges: integer(row, 'max_plan_changes'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}

export function mapSubject(row: DatabaseRow): Subject {
  return subjectSchema.parse({
    id: text(row, 'id'),
    kind: text(row, 'kind'),
    classification: text(row, 'classification'),
    displayName: text(row, 'display_name'),
    ...(optionalText(row, 'primary_email') === undefined
      ? {}
      : { primaryEmail: optionalText(row, 'primary_email') }),
    status: text(row, 'status'),
    directoryState: text(row, 'directory_state'),
    protected: booleanValue(row, 'protected'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}

export function mapExternalIdentity(row: DatabaseRow): ExternalIdentity {
  return externalIdentitySchema.parse({
    id: text(row, 'id'),
    subjectId: text(row, 'subject_id'),
    provider: text(row, 'provider'),
    issuer: text(row, 'issuer'),
    providerSubject: text(row, 'provider_subject'),
    ...(optionalText(row, 'display_name') === undefined
      ? {}
      : { displayName: optionalText(row, 'display_name') }),
    ...(optionalText(row, 'email') === undefined ? {} : { email: optionalText(row, 'email') }),
    status: text(row, 'status'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}

export function mapGuestProfile(row: DatabaseRow): GuestProfile {
  return guestProfileSchema.parse({
    subjectId: text(row, 'subject_id'),
    sponsorSubjectId: text(row, 'sponsor_subject_id'),
    externalContactEmail: text(row, 'external_contact_email'),
    externalOrganization: text(row, 'external_organization'),
    purpose: text(row, 'purpose'),
    validFrom: text(row, 'valid_from'),
    expiresAt: text(row, 'expires_at'),
    ...(optionalText(row, 'next_review_at') === undefined
      ? {}
      : { nextReviewAt: optionalText(row, 'next_review_at') }),
    status: text(row, 'status'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}

export function mapPlatformRoleGrant(row: DatabaseRow): PlatformRoleGrant {
  return platformRoleGrantSchema.parse({
    id: text(row, 'id'),
    subjectId: text(row, 'subject_id'),
    role: text(row, 'role'),
    active: booleanValue(row, 'active'),
    protected: booleanValue(row, 'protected'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}
