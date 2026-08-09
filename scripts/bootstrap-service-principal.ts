import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  assertServicePrincipalBootstrapAllowed,
  createServicePrincipalBootstrapRecords,
} from '@access-control/application';
import { httpsUrlSchema } from '@access-control/domain';
import { executeD1Sql, queryD1Rows, sqlLiteral } from './wrangler-d1-command';

const commandArguments = process.argv.slice(2);
if (commandArguments[0] === '--') commandArguments.shift();
const { values } = parseArgs({
  args: commandArguments,
  options: {
    environment: { type: 'string' },
    database: { type: 'string' },
    issuer: { type: 'string' },
    'common-name': { type: 'string' },
    role: { type: 'string' },
  },
  strict: true,
});

const input = z
  .object({
    environment: z.enum(['staging', 'production']),
    database: z.string().trim().min(1).max(128),
    issuer: httpsUrlSchema.max(500),
    commonName: z.string().trim().min(1).max(160),
    role: z.enum(['auditor', 'operator']),
  })
  .strict()
  .parse({
    environment: values.environment,
    database: values.database,
    issuer: values.issuer,
    commonName: values['common-name'],
    role: values.role,
  });

const target = { database: input.database, environment: input.environment };
const administrators = queryD1Rows(
  target,
  `SELECT subjects.id
   FROM platform_role_grants grants
   JOIN subjects ON subjects.id = grants.subject_id
   WHERE grants.role = 'admin' AND grants.active = 1 AND subjects.status = 'active'
   ORDER BY subjects.id
   LIMIT 1`,
);
const administratorId = optionalString(administrators[0]?.id);
const duplicateIdentityExists =
  Number(
    queryD1Rows(
      target,
      `SELECT count(*) AS count
       FROM external_identities
       WHERE provider = 'cloudflare_access'
         AND issuer = ${sqlLiteral(input.issuer)}
         AND provider_subject = ${sqlLiteral(input.commonName)}`,
    )[0]?.count ?? 0,
  ) > 0;
const actorId = assertServicePrincipalBootstrapAllowed({
  ...(administratorId === undefined ? {} : { activeAdministratorId: administratorId }),
  duplicateIdentityExists,
});

const records = createServicePrincipalBootstrapRecords(
  {
    administratorId: actorId,
    issuer: input.issuer,
    commonName: input.commonName,
    role: input.role,
    requestId: `bootstrap:${randomUUID()}`,
  },
  {
    now: () => new Date().toISOString(),
    id: (prefix) => `${prefix}:${randomUUID()}`,
  },
);
const guardId = `bootstrap:${randomUUID()}`;
const audit = records.mutation.auditEvent;
const outbox = records.mutation.outboxRecord;

const sql = `
INSERT INTO mutation_guards (id, is_valid)
SELECT ${sqlLiteral(guardId)}, CASE WHEN EXISTS (
  SELECT 1 FROM platform_role_grants grants
  JOIN subjects ON subjects.id = grants.subject_id
  WHERE grants.subject_id = ${sqlLiteral(actorId)}
    AND grants.role = 'admin' AND grants.active = 1 AND subjects.status = 'active'
) AND NOT EXISTS (
  SELECT 1 FROM external_identities
  WHERE provider = 'cloudflare_access'
    AND issuer = ${sqlLiteral(input.issuer)}
    AND provider_subject = ${sqlLiteral(input.commonName)}
) THEN 1 ELSE 0 END;

INSERT INTO subjects (
  id, kind, classification, display_name, primary_email, status, directory_state,
  protected, revision, created_at, updated_at, created_by, updated_by
) VALUES (
  ${sqlLiteral(records.subject.id)}, ${sqlLiteral(records.subject.kind)},
  ${sqlLiteral(records.subject.classification)}, ${sqlLiteral(records.subject.displayName)},
  ${nullableSqlLiteral(records.subject.primaryEmail)}, ${sqlLiteral(records.subject.status)},
  ${sqlLiteral(records.subject.directoryState)}, ${booleanInteger(records.subject.protected)},
  ${records.subject.revision}, ${sqlLiteral(records.subject.createdAt)},
  ${sqlLiteral(records.subject.updatedAt)}, ${sqlLiteral(records.subject.createdBy)},
  ${sqlLiteral(records.subject.updatedBy)}
);

INSERT INTO external_identities (
  id, subject_id, provider, issuer, provider_subject, display_name, email,
  status, revision, created_at, updated_at, created_by, updated_by
) VALUES (
  ${sqlLiteral(records.identity.id)}, ${sqlLiteral(records.identity.subjectId)},
  ${sqlLiteral(records.identity.provider)}, ${sqlLiteral(records.identity.issuer)},
  ${sqlLiteral(records.identity.providerSubject)},
  ${nullableSqlLiteral(records.identity.displayName)}, ${nullableSqlLiteral(records.identity.email)},
  ${sqlLiteral(records.identity.status)}, ${records.identity.revision},
  ${sqlLiteral(records.identity.createdAt)}, ${sqlLiteral(records.identity.updatedAt)},
  ${sqlLiteral(records.identity.createdBy)}, ${sqlLiteral(records.identity.updatedBy)}
);

INSERT INTO platform_role_grants (
  id, subject_id, role, active, protected, revision,
  created_at, updated_at, created_by, updated_by
) VALUES (
  ${sqlLiteral(records.roleGrant.id)}, ${sqlLiteral(records.roleGrant.subjectId)},
  ${sqlLiteral(records.roleGrant.role)}, ${booleanInteger(records.roleGrant.active)},
  ${booleanInteger(records.roleGrant.protected)}, ${records.roleGrant.revision},
  ${sqlLiteral(records.roleGrant.createdAt)}, ${sqlLiteral(records.roleGrant.updatedAt)},
  ${sqlLiteral(records.roleGrant.createdBy)}, ${sqlLiteral(records.roleGrant.updatedBy)}
);

UPDATE grant_input_versions
SET revision = revision + 1
WHERE name = 'effective_grants';

INSERT INTO audit_events (
  id, event_type, actor_subject_id, target_type, target_id, action, reason,
  request_id, result, previous_revision, resulting_revision, provider_evidence_ref,
  payload_json, occurred_at
) VALUES (
  ${sqlLiteral(audit.id)}, ${sqlLiteral(audit.eventType)},
  ${nullableSqlLiteral(audit.actorSubjectId)}, ${sqlLiteral(audit.targetType)},
  ${sqlLiteral(audit.targetId)}, ${sqlLiteral(audit.action)},
  ${nullableSqlLiteral(audit.reason)}, ${sqlLiteral(audit.requestId)},
  ${sqlLiteral(audit.result)}, ${nullableNumber(audit.previousRevision)},
  ${nullableNumber(audit.resultingRevision)}, ${nullableSqlLiteral(audit.providerEvidenceRef)},
  ${sqlLiteral(JSON.stringify(audit.payload))}, ${sqlLiteral(audit.occurredAt)}
);

INSERT INTO outbox (
  id, audit_event_id, topic, payload_json, status, attempts,
  created_at, updated_at, delivered_at, last_error_code
) VALUES (
  ${sqlLiteral(outbox.id)}, ${sqlLiteral(outbox.auditEventId)}, ${sqlLiteral(outbox.topic)},
  ${sqlLiteral(JSON.stringify(outbox.payload))}, ${sqlLiteral(outbox.status)},
  ${outbox.attempts}, ${sqlLiteral(outbox.createdAt)}, ${sqlLiteral(outbox.updatedAt)},
  ${nullableSqlLiteral(outbox.deliveredAt)}, ${nullableSqlLiteral(outbox.lastErrorCode)}
);

DELETE FROM mutation_guards WHERE id = ${sqlLiteral(guardId)};
`;

executeD1Sql(target, sql);
console.log(
  `Bootstrapped ${input.role} service principal ${records.subject.id} in ${input.environment}.`,
);
console.log(`External identity: cloudflare_access | ${input.issuer} | ${input.commonName}`);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nullableSqlLiteral(value: string | undefined): string {
  return value === undefined ? 'NULL' : sqlLiteral(value);
}

function nullableNumber(value: number | undefined): string {
  return value === undefined ? 'NULL' : String(value);
}

function booleanInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
