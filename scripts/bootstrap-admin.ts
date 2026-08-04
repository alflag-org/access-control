import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { httpsUrlSchema } from '@access-control/domain';
import { executeD1Sql, queryD1Rows, sqlLiteral } from './wrangler-d1-command';

const commandArguments = process.argv.slice(2);
if (commandArguments[0] === '--') commandArguments.shift();
const { values } = parseArgs({
  args: commandArguments,
  options: {
    environment: { type: 'string' },
    database: { type: 'string' },
    identity: { type: 'string' },
    issuer: { type: 'string' },
    'display-name': { type: 'string' },
    'organization-name': { type: 'string' },
    'support-url': { type: 'string' },
  },
  strict: true,
});

const input = z
  .object({
    environment: z.enum(['development', 'staging', 'production']),
    database: z.string().trim().min(1).max(128),
    identity: z.string().regex(/^access:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
    issuer: httpsUrlSchema.max(500).optional(),
    displayName: z.string().trim().min(1).max(160),
    organizationName: z.string().trim().min(1).max(160),
    supportUrl: httpsUrlSchema.optional(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.environment !== 'development' && candidate.issuer === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['issuer'],
        message: 'Production bootstrap requires --issuer.',
      });
    }
  })
  .parse({
    environment: values.environment,
    database: values.database,
    identity: values.identity,
    issuer: values.issuer,
    displayName: values['display-name'],
    organizationName: values['organization-name'],
    supportUrl: values['support-url'],
  });

const target = { database: input.database, environment: input.environment };
const existing = queryD1Rows(
  target,
  `SELECT count(*) AS count
   FROM platform_role_grants grants
   JOIN subjects ON subjects.id = grants.subject_id
   WHERE grants.role = 'admin' AND grants.active = 1 AND subjects.status = 'active'`,
);
if (Number(existing[0]?.count ?? 0) > 0) {
  throw new Error('administrator_already_bootstrapped: an active administrator already exists.');
}

const now = new Date().toISOString();
const providerSubject = input.identity.slice('access:'.length);
const issuer = input.environment === 'development' ? 'local://access-control' : input.issuer;
if (issuer === undefined) throw new Error('access_issuer_required');
const subjectId = `subject:${randomUUID()}`;
const identityId = `identity:${randomUUID()}`;
const grantId = `role-grant:${randomUUID()}`;
const auditId = `audit:${randomUUID()}`;
const outboxId = `outbox:${randomUUID()}`;
const guardId = `bootstrap:${randomUUID()}`;
const requestId = `bootstrap:${randomUUID()}`;
const supportUrl = input.supportUrl === undefined ? 'NULL' : sqlLiteral(input.supportUrl);
const auditPayload = JSON.stringify({ externalIdentityId: identityId, subjectId });

const sql = `
INSERT INTO mutation_guards (id, is_valid)
SELECT ${sqlLiteral(guardId)}, CASE WHEN NOT EXISTS (
  SELECT 1 FROM platform_role_grants grants
  JOIN subjects ON subjects.id = grants.subject_id
  WHERE grants.role = 'admin' AND grants.active = 1 AND subjects.status = 'active'
) THEN 1 ELSE 0 END;

INSERT INTO subjects (
  id, kind, classification, display_name, primary_email, status, directory_state,
  protected, revision, created_at, updated_at, created_by, updated_by
) VALUES (
  ${sqlLiteral(subjectId)}, 'human', 'member', ${sqlLiteral(input.displayName)}, NULL,
  'active', 'pending', 1, 1, ${sqlLiteral(now)}, ${sqlLiteral(now)},
  ${sqlLiteral(subjectId)}, ${sqlLiteral(subjectId)}
);

INSERT INTO organization_settings (
  id, organization_name, title, support_url, brand_mark_url,
  max_plan_changes, revision, created_at, updated_at, created_by, updated_by
) VALUES (
  'organization', ${sqlLiteral(input.organizationName)}, ${sqlLiteral(input.organizationName)},
  ${supportUrl}, NULL, 20, 1, ${sqlLiteral(now)}, ${sqlLiteral(now)},
  ${sqlLiteral(subjectId)}, ${sqlLiteral(subjectId)}
);

INSERT INTO external_identities (
  id, subject_id, provider, issuer, provider_subject, display_name, email,
  status, revision, created_at, updated_at, created_by, updated_by
) VALUES (
  ${sqlLiteral(identityId)}, ${sqlLiteral(subjectId)}, 'cloudflare_access', ${sqlLiteral(issuer)},
  ${sqlLiteral(providerSubject)}, ${sqlLiteral(input.displayName)}, NULL, 'active', 1,
  ${sqlLiteral(now)}, ${sqlLiteral(now)}, ${sqlLiteral(subjectId)}, ${sqlLiteral(subjectId)}
);

INSERT INTO platform_role_grants (
  id, subject_id, role, active, protected, revision,
  created_at, updated_at, created_by, updated_by
) VALUES (
  ${sqlLiteral(grantId)}, ${sqlLiteral(subjectId)}, 'admin', 1, 1, 1,
  ${sqlLiteral(now)}, ${sqlLiteral(now)}, ${sqlLiteral(subjectId)}, ${sqlLiteral(subjectId)}
);

INSERT INTO audit_events (
  id, event_type, actor_subject_id, target_type, target_id, action, reason,
  request_id, result, previous_revision, resulting_revision, provider_evidence_ref,
  payload_json, occurred_at
) VALUES (
  ${sqlLiteral(auditId)}, 'access-control.organization.bootstrapped', ${sqlLiteral(subjectId)},
  'organization_settings', 'organization', 'bootstrap', 'one-shot administrator bootstrap',
  ${sqlLiteral(requestId)}, 'succeeded', NULL, 1, NULL,
  ${sqlLiteral(auditPayload)}, ${sqlLiteral(now)}
);

INSERT INTO outbox (
  id, audit_event_id, topic, payload_json, status, attempts,
  created_at, updated_at, delivered_at, last_error_code
) VALUES (
  ${sqlLiteral(outboxId)}, ${sqlLiteral(auditId)}, 'access-control.organization.bootstrapped',
  ${sqlLiteral(auditPayload)}, 'pending', 0, ${sqlLiteral(now)}, ${sqlLiteral(now)}, NULL, NULL
);

DELETE FROM mutation_guards WHERE id = ${sqlLiteral(guardId)};
`;

executeD1Sql(target, sql);
console.log(`Bootstrapped administrator ${subjectId} in ${input.environment}.`);
console.log(`External identity: cloudflare_access | ${issuer} | ${providerSubject}`);
