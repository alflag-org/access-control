import { describe, expect, it } from 'vitest';
import {
  createOrganizationSettingsCandidate,
  createPlatformRoleGrantCandidate,
} from '@access-control/domain';
import {
  renderApplicationsAdmin,
  renderGuestsAdmin,
  renderMappingsAdmin,
  renderPeopleAdmin,
  renderSettingsAdmin,
} from '../../apps/worker/src/ui/pages/admin';
import {
  FIXTURE_TIME,
  activeGuest,
  activeMapping,
  application,
  entitlement,
  googleIdentity,
  memberSubject,
  sourceGroup,
} from '../fixtures/domain-fixtures';

const administrator = {
  canManageConfiguration: true,
  canManageIdentities: true,
};
const auditor = {
  canManageConfiguration: false,
  canManageIdentities: false,
};

describe('Administration editing surfaces', () => {
  it('exposes revision-checked Subject status and role controls only to administrators', () => {
    const subject = memberSubject();
    const roleGrant = createPlatformRoleGrantCandidate({
      id: 'role-grant:operator',
      subjectId: subject.id,
      role: 'operator',
      active: true,
      protected: false,
      revision: 2,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
      createdBy: subject.id,
      updatedBy: subject.id,
    });
    const editable = renderPeopleAdmin({
      subjects: [subject],
      roleGrants: [roleGrant],
      capabilities: administrator,
    });
    const readOnly = renderPeopleAdmin({
      subjects: [subject],
      roleGrants: [roleGrant],
      capabilities: auditor,
    });

    expect(editable).toContain('action="/api/v1/subjects/subject:member"');
    expect(editable).toContain('data-http-method="patch"');
    expect(editable).toContain('name="expectedRevision" value="1" data-value-type="number"');
    expect(editable).toContain('/platform-role-grants');
    expect(editable).toContain('action="/api/v1/platform-role-grants/role-grant:operator"');
    expect(readOnly).not.toContain('data-json-form');
    expect(readOnly).toContain('運用担当');
  });

  it('offers local profile editing and explains directory-owned profiles', () => {
    const localSubject = memberSubject({
      id: 'subject:local-profile',
      displayName: 'Local Profile',
      directoryState: 'pending',
      primaryEmail: 'local@example.org',
    });
    const localHtml = renderPeopleAdmin({
      subjects: [localSubject],
      roleGrants: [],
      capabilities: administrator,
    });
    expect(localHtml).toContain('action="/api/v1/subjects/subject:local-profile/profile"');
    expect(localHtml).toContain('name="displayName" required type="text" value="Local Profile"');
    expect(localHtml).toContain('name="primaryEmail"');
    expect(localHtml).toContain('Access Control');

    const directoryHtml = renderPeopleAdmin({
      subjects: [memberSubject()],
      roleGrants: [],
      capabilities: administrator,
    });
    expect(directoryHtml).toContain('Google Directory');
    expect(directoryHtml).toContain('Google Workspace 側で変更してから同期してください。');
    expect(directoryHtml).not.toContain('/profile"');
  });

  it('renders create and update forms for applications and their entitlements', () => {
    const editable = renderApplicationsAdmin({
      applications: [application({ name: '<Source Control>' })],
      entitlements: [entitlement()],
      capabilities: administrator,
    });
    const readOnly = renderApplicationsAdmin({
      applications: [application()],
      entitlements: [entitlement()],
      capabilities: auditor,
    });

    expect(editable).toContain('action="/api/v1/applications"');
    expect(editable).toContain('action="/api/v1/applications/application:source-control"');
    expect(editable).toContain(
      'action="/api/v1/applications/application:source-control/entitlements/entitlement:source-control-member"',
    );
    expect(editable).toContain('&lt;Source Control&gt;');
    expect(editable).not.toContain('<Source Control>');
    expect(readOnly).not.toContain('data-json-form');
  });

  it('lets administrators bind an immutable Google or GitHub identity to a managed guest', () => {
    const guestSubject = memberSubject({
      id: 'subject:guest',
      classification: 'managed_guest',
      status: 'pending',
    });
    const sponsor = memberSubject({ id: 'subject:sponsor', displayName: 'Sponsor' });
    const html = renderGuestsAdmin({
      guests: [activeGuest({ subjectId: guestSubject.id })],
      identities: [googleIdentity({ subjectId: guestSubject.id })],
      subjects: [guestSubject, sponsor],
      capabilities: administrator,
    });

    expect(html).toContain('action="/api/v1/subjects/subject:guest/identities"');
    expect(html).toContain('data-identity-provider');
    expect(html).toContain('name="expectedSubjectRevision" value="1"');
    expect(html).toContain('プロバイダー内の変更できない ID');
  });

  it('renders a profile and contact form for a locally managed guest', () => {
    const guestSubject = memberSubject({
      id: 'subject:local-guest',
      classification: 'managed_guest',
      directoryState: 'pending',
      status: 'active',
      primaryEmail: 'guest@example.org',
    });
    const html = renderGuestsAdmin({
      guests: [activeGuest({ subjectId: guestSubject.id })],
      identities: [],
      subjects: [guestSubject],
      capabilities: administrator,
    });

    expect(html).toContain('action="/api/v1/guests/subject:local-guest/profile"');
    expect(html).toContain(
      'name="externalContactEmail" required type="email" value="ada.external@example.net"',
    );
    expect(html).toContain(
      'name="externalOrganization" required type="text" value="Example Partner"',
    );
    expect(html).toContain('name="purpose"');
  });

  it('requires a fresh mapping preview before rendering an activation request', () => {
    const html = renderMappingsAdmin({
      mappings: [activeMapping({ status: 'draft' })],
      groups: [sourceGroup()],
      entitlements: [entitlement()],
      provisioningTargets: [],
      capabilities: administrator,
    });

    expect(html).toContain('/mappings/mapping:source-control-member/preview');
    expect(html).toContain('data-preview-output="mapping-preview-0"');
    expect(html).toContain('/mappings/mapping:source-control-member/activate');
    expect(html).toContain('name="confirmedAffectedSubjectIds" value="[]" data-value-type="json"');
  });

  it('keeps organization settings editable only for administrators', () => {
    const settings = createOrganizationSettingsCandidate({
      id: 'organization:settings',
      organizationName: 'Example Organization',
      title: 'Example Access Control',
      maxPlanChanges: 20,
      revision: 3,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
      createdBy: 'subject:member',
      updatedBy: 'subject:member',
    });
    const base = {
      settings,
      directorySources: [],
      providerConnections: [],
      provisioningTargets: [],
      entitlements: [],
    };

    const editable = renderSettingsAdmin({ ...base, capabilities: administrator });
    const readOnly = renderSettingsAdmin({ ...base, capabilities: auditor });

    expect(editable).toContain('action="/api/v1/organization-settings"');
    expect(editable).toContain('name="expectedRevision" value="3" data-value-type="number"');
    expect(readOnly).not.toContain('action="/api/v1/organization-settings"');
    expect(readOnly).toContain('組織設定の変更には管理者ロールが必要です。');
  });
});
