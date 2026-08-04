import {
  AccessControlError,
  bindingReferenceSchema,
  canonicalJson,
  createExportRecordCandidate,
  jsonValueSchema,
  type ExportRecord,
  type JsonValue,
} from '@access-control/domain';
import {
  portableExportPayloadSchema,
  portableExportSchema,
  type PortableExport,
} from '@access-control/contracts';
import { createMutationRecords } from './events';
import type { ExportRepository } from './ports';
import type { ServiceRuntime } from './runtime';
import type { RequiredActorContext } from './catalog';

export interface ExportObjectWriter {
  get(key: string): Promise<StoredExportObject | null>;
  putTemporaryIfAbsent(key: string, value: string, checksum: string): Promise<boolean>;
  putFinalIfAbsent(key: string, value: string, checksum: string): Promise<boolean>;
  deleteTemporary(key: string): Promise<void>;
}

export interface StoredExportObject {
  value: string;
  checksum?: string;
}

export class ExportService {
  public constructor(
    private readonly repository: ExportRepository,
    private readonly runtime: ServiceRuntime,
  ) {}

  public async request(context: RequiredActorContext): Promise<ExportRecord> {
    const now = this.runtime.now();
    const record = createExportRecordCandidate({
      id: this.runtime.id('export'),
      schemaVersion: '1.0.0',
      status: 'planned',
      revision: 1,
      requestedBy: context.actorSubjectId,
      createdAt: now,
      updatedAt: now,
    });
    await this.repository.createExportRecord(
      record,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.export.requested',
        topic: 'access-control.export.requested',
        targetType: 'export',
        targetId: record.id,
        action: 'request',
        resultingRevision: 1,
        payload: { exportId: record.id, schemaVersion: record.schemaVersion },
      }),
    );
    return record;
  }

  public async materialize(
    exportId: string,
    claimId: string,
    writer: ExportObjectWriter,
    context: RequiredActorContext,
  ): Promise<PortableExport> {
    let record = await this.repository.getExportRecord(exportId);
    if (record === null) {
      throw new AccessControlError(404, 'export_not_found', `Export ${exportId} was not found.`);
    }
    if (record.status === 'completed') return this.readCompletedExport(record, writer);
    if (record.status === 'planned') {
      const claimed = await this.repository.claimExportRecord(
        record.id,
        claimId,
        record.revision,
        this.runtime.now(),
      );
      if (claimed !== null) {
        record = claimed;
      } else {
        const current = await this.repository.getExportRecord(record.id);
        if (current === null) {
          throw new AccessControlError(
            404,
            'export_not_found',
            `Export ${exportId} was not found.`,
          );
        }
        record = current;
      }
    }
    if (record.status === 'completed') return this.readCompletedExport(record, writer);
    if (record.status !== 'running' || record.claimId !== claimId) {
      throw new AccessControlError(
        409,
        'export_not_claimed',
        'Only the Outbox delivery that claimed a running export can materialize it.',
      );
    }
    const objectKey = `exports/${record.id}.json`;
    const temporaryObjectKey = `exports/.staging/${record.id}.json`;
    const existingFinal = await writer.get(objectKey);
    if (existingFinal !== null) {
      const portableExport = await validateStoredExportObject(existingFinal, objectKey);
      assertExportClaim(portableExport, record);
      return this.completeClaimedExport(record, objectKey, portableExport, writer, context);
    }

    let staged = await writer.get(temporaryObjectKey);
    if (staged === null) {
      const payload = portableExportPayloadSchema.parse(
        await this.repository.buildPortableExportPayload(record.updatedAt),
      );
      const jsonPayload = toJsonValue(payload);
      assertNoSecretMaterial(jsonPayload);
      const checksum = await hashText(canonicalJson(jsonPayload));
      const portableExport = portableExportSchema.parse({ ...payload, checksum });
      const serialized = `${JSON.stringify(portableExport, null, 2)}\n`;
      await writer.putTemporaryIfAbsent(temporaryObjectKey, serialized, checksum);
      staged = await writer.get(temporaryObjectKey);
      if (staged === null) {
        throw new AccessControlError(
          503,
          'export_temporary_object_missing',
          'The temporary export object was not readable after it was written.',
        );
      }
    }
    const portableExport = await validateStoredExportObject(staged, temporaryObjectKey);
    assertExportClaim(portableExport, record);
    const serialized = `${JSON.stringify(portableExport, null, 2)}\n`;
    await writer.putFinalIfAbsent(objectKey, serialized, portableExport.checksum);
    const finalized = await writer.get(objectKey);
    if (finalized === null) {
      throw new AccessControlError(
        503,
        'export_final_object_missing',
        'The final export object was not readable after finalization.',
      );
    }
    const finalizedExport = await validateStoredExportObject(finalized, objectKey);
    assertExportClaim(finalizedExport, record);
    if (finalizedExport.checksum !== portableExport.checksum) {
      throw new AccessControlError(
        409,
        'export_final_object_conflict',
        'The final export key contains a different valid payload.',
      );
    }
    return this.completeClaimedExport(record, objectKey, finalizedExport, writer, context);
  }

  private async readCompletedExport(
    record: ExportRecord,
    writer: ExportObjectWriter,
  ): Promise<PortableExport> {
    if (record.objectKey === undefined || record.checksum === undefined) {
      throw new AccessControlError(
        409,
        'completed_export_metadata_missing',
        'The completed export record has no object key or checksum.',
      );
    }
    const stored = await writer.get(record.objectKey);
    if (stored === null) {
      throw new AccessControlError(
        503,
        'completed_export_object_missing',
        'The completed export object is missing from R2.',
      );
    }
    const portableExport = await validateStoredExportObject(stored, record.objectKey);
    if (portableExport.checksum !== record.checksum) {
      throw new AccessControlError(
        409,
        'completed_export_checksum_mismatch',
        'The D1 export checksum does not match the final R2 object.',
      );
    }
    return portableExport;
  }

  private async completeClaimedExport(
    record: ExportRecord,
    objectKey: string,
    portableExport: PortableExport,
    writer: ExportObjectWriter,
    context: RequiredActorContext,
  ): Promise<PortableExport> {
    if (record.claimId === undefined) {
      throw new AccessControlError(
        409,
        'export_claim_missing',
        'The running Export record has no Outbox claim.',
      );
    }
    const completedAt = this.runtime.now();
    const completed = createExportRecordCandidate({
      ...record,
      status: 'completed',
      objectKey,
      checksum: portableExport.checksum,
      entityCount: countEntities(portableExport),
      revision: record.revision + 1,
      updatedAt: completedAt,
      completedAt,
    });
    await this.repository.completeExportRecord(
      completed,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.export.completed',
        topic: 'access-control.export.completed',
        targetType: 'export',
        targetId: record.id,
        action: 'complete',
        previousRevision: record.revision,
        resultingRevision: completed.revision,
        payload: {
          objectKey,
          checksum: portableExport.checksum,
          entityCount: completed.entityCount ?? 0,
        },
      }),
      record.revision,
      record.claimId,
    );
    await writer.deleteTemporary(`exports/.staging/${record.id}.json`).catch(() => undefined);
    return portableExport;
  }
}

async function validateStoredExportObject(
  object: StoredExportObject,
  objectKey: string,
): Promise<PortableExport> {
  let value: unknown;
  try {
    value = JSON.parse(object.value);
  } catch {
    throw new AccessControlError(
      422,
      'export_object_json_invalid',
      `Export object ${objectKey} is not valid JSON.`,
    );
  }
  const validated = await validatePortableExport(value);
  if (object.checksum !== validated.export.checksum) {
    throw new AccessControlError(
      422,
      'export_object_metadata_mismatch',
      `Export object ${objectKey} has inconsistent checksum metadata.`,
    );
  }
  return validated.export;
}

function assertExportClaim(portableExport: PortableExport, record: ExportRecord): void {
  const embedded = portableExport.entities.exportRecords.find(
    (candidate) => candidate.id === record.id,
  );
  if (
    embedded === undefined ||
    embedded.claimId !== record.claimId ||
    embedded.status !== 'running'
  ) {
    throw new AccessControlError(
      409,
      'export_object_claim_mismatch',
      'The export object was not produced from the claimed Export record.',
    );
  }
}

export async function validatePortableExport(value: unknown): Promise<{
  export: PortableExport;
  entityCounts: Record<string, number>;
}> {
  const parsed = portableExportSchema.parse(value);
  assertNoSecretMaterial(toJsonValue(parsed));
  const { checksum, ...payload } = parsed;
  const actual = await hashText(canonicalJson(toJsonValue(payload)));
  if (actual !== checksum) {
    throw new AccessControlError(
      422,
      'export_checksum_mismatch',
      'The export checksum does not match its payload.',
    );
  }
  return {
    export: parsed,
    entityCounts: Object.fromEntries(
      Object.entries(parsed.entities).map(([name, entities]) => [name, entities.length]),
    ),
  };
}

export function assertNoSecretMaterial(value: JsonValue): void {
  inspectForSecrets(value, '$');
}

function inspectForSecrets(value: JsonValue, path: string): void {
  if (typeof value === 'string') {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) {
      throw new AccessControlError(
        422,
        'secret_material_detected',
        `Private key material found at ${path}.`,
      );
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectForSecrets(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
    const isReference = normalized.endsWith('ref') || normalized.endsWith('binding');
    if (isReference && !bindingReferenceSchema.safeParse(entry).success) {
      throw new AccessControlError(
        422,
        'secret_field_detected',
        `Invalid runtime binding reference found at ${path}.${key}.`,
      );
    }
    if (
      !isReference &&
      /(?:apikey|authorization|clientsecret|credential|password|privatekey|refreshtoken|secret|token)/.test(
        normalized,
      )
    ) {
      throw new AccessControlError(
        422,
        'secret_field_detected',
        `Secret-like field found at ${path}.${key}.`,
      );
    }
    inspectForSecrets(entry, `${path}.${key}`);
  }
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function countEntities(value: PortableExport): number {
  return Object.values(value.entities).reduce((count, entities) => count + entities.length, 0);
}

function toJsonValue(value: unknown): JsonValue {
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
}
