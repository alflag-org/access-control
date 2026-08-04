import type { AuditRepository } from '@access-control/application';
import {
  AccessControlError,
  databaseConflict,
  type AuditEvent,
  type OutboxRecord,
} from '@access-control/domain';
import { D1Client } from './client';
import { mapAuditEvent, mapOutboxRecord } from './event-rows';
import type { DatabaseRow } from './row-values';

export class D1AuditRepository extends D1Client implements AuditRepository {
  public async listAuditEvents(): Promise<AuditEvent[]> {
    return (
      await this.all<DatabaseRow>('SELECT * FROM audit_events ORDER BY occurred_at DESC, id')
    ).map(mapAuditEvent);
  }

  public async getOutboxRecord(id: string): Promise<OutboxRecord | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM outbox WHERE id = ?', id);
    return row === null ? null : mapOutboxRecord(row);
  }

  public async listPendingOutboxRecords(limit: number): Promise<OutboxRecord[]> {
    return (
      await this.all<DatabaseRow>(
        `SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at, id LIMIT ?`,
        limit,
      )
    ).map(mapOutboxRecord);
  }

  public async claimOutboxRecord(
    outboxId: string,
    claimedAt: string,
  ): Promise<OutboxRecord | null> {
    let result: D1Result<unknown>;
    try {
      result = await this.statement(
        `UPDATE outbox SET
          status = 'dispatching', attempts = attempts + 1, updated_at = ?,
          delivered_at = NULL, last_error_code = NULL
         WHERE id = ? AND status = 'pending'`,
        claimedAt,
        outboxId,
      ).run();
    } catch (error) {
      throw databaseConflict(error);
    }
    if (result.meta.changes !== 1) return null;
    return this.getOutboxRecord(outboxId);
  }

  public async markOutboxDispatched(outboxId: string, deliveredAt: string): Promise<void> {
    let result: D1Result<unknown>;
    try {
      result = await this.statement(
        `UPDATE outbox SET
          status = 'delivered', updated_at = ?, delivered_at = ?, last_error_code = NULL
         WHERE id = ? AND status = 'dispatching'`,
        deliveredAt,
        deliveredAt,
        outboxId,
      ).run();
    } catch (error) {
      throw databaseConflict(error);
    }
    if (result.meta.changes === 1) return;
    if ((await this.getOutboxRecord(outboxId))?.status === 'delivered') return;
    throw outboxStateConflict(outboxId, 'dispatching');
  }

  public async markOutboxFailed(
    outboxId: string,
    errorCode: string,
    updatedAt: string,
  ): Promise<void> {
    let result: D1Result<unknown>;
    try {
      result = await this.statement(
        `UPDATE outbox SET
          status = 'failed', updated_at = ?, delivered_at = NULL, last_error_code = ?
         WHERE id = ? AND status = 'dispatching'`,
        updatedAt,
        errorCode,
        outboxId,
      ).run();
    } catch (error) {
      throw databaseConflict(error);
    }
    if (result.meta.changes === 1) return;
    if ((await this.getOutboxRecord(outboxId))?.status === 'failed') return;
    throw outboxStateConflict(outboxId, 'dispatching');
  }

  public async claimOutboxDelivery(
    outboxId: string,
    messageId: string,
    claimedAt: string,
    claimExpiresAt: string,
  ): Promise<'claimed' | 'processing' | 'delivered'> {
    let result: D1Result<unknown>;
    try {
      result = await this.statement(
        `INSERT INTO outbox_delivery_receipts (
          outbox_id, message_id, status, attempts, claimed_at, claim_expires_at,
          delivered_at, last_error_code
        )
        SELECT ?, ?, 'processing', 1, ?, ?, NULL, NULL
        FROM outbox
        WHERE id = ? AND status IN ('dispatching', 'delivered')
        ON CONFLICT(outbox_id) DO UPDATE SET
          message_id = excluded.message_id,
          status = 'processing',
          attempts = outbox_delivery_receipts.attempts + 1,
          claimed_at = excluded.claimed_at,
          claim_expires_at = excluded.claim_expires_at,
          delivered_at = NULL,
          last_error_code = NULL
        WHERE outbox_delivery_receipts.status = 'failed'
           OR (
             outbox_delivery_receipts.status = 'processing'
             AND outbox_delivery_receipts.claim_expires_at <= excluded.claimed_at
           )`,
        outboxId,
        messageId,
        claimedAt,
        claimExpiresAt,
        outboxId,
      ).run();
    } catch (error) {
      throw databaseConflict(error);
    }
    if (result.meta.changes === 1) return 'claimed';
    const receipt = await this.first<{ status: string }>(
      'SELECT status FROM outbox_delivery_receipts WHERE outbox_id = ?',
      outboxId,
    );
    if (receipt?.status === 'delivered') return 'delivered';
    if (receipt?.status === 'processing') return 'processing';
    throw new AccessControlError(
      409,
      'outbox_not_dispatched',
      `Outbox record ${outboxId} is not available for Queue delivery.`,
    );
  }

  public async completeOutboxDelivery(
    outboxId: string,
    messageId: string,
    deliveredAt: string,
  ): Promise<void> {
    let results: D1Result<unknown>[];
    try {
      results = await this.db.batch([
        this.statement(
          `UPDATE outbox_delivery_receipts SET
            status = 'delivered', claim_expires_at = ?, delivered_at = ?, last_error_code = NULL
           WHERE outbox_id = ? AND message_id = ? AND status = 'processing'`,
          deliveredAt,
          deliveredAt,
          outboxId,
          messageId,
        ),
        this.statement(
          `UPDATE outbox SET
            status = 'delivered', updated_at = ?, delivered_at = ?, last_error_code = NULL
           WHERE id = ? AND status = 'dispatching'
             AND EXISTS (
               SELECT 1 FROM outbox_delivery_receipts
               WHERE outbox_id = ? AND message_id = ? AND status = 'delivered'
             )`,
          deliveredAt,
          deliveredAt,
          outboxId,
          outboxId,
          messageId,
        ),
      ]);
    } catch (error) {
      throw databaseConflict(error);
    }
    if (results[0]?.meta.changes === 1) return;
    const receipt = await this.first<{ status: string }>(
      `SELECT status FROM outbox_delivery_receipts
       WHERE outbox_id = ? AND message_id = ?`,
      outboxId,
      messageId,
    );
    if (receipt?.status === 'delivered') return;
    throw new AccessControlError(
      409,
      'outbox_delivery_claim_lost',
      `Queue delivery no longer owns Outbox record ${outboxId}.`,
    );
  }

  public async markOutboxDeliveryFailed(
    outboxId: string,
    messageId: string,
    errorCode: string,
    updatedAt: string,
  ): Promise<void> {
    try {
      await this.statement(
        `UPDATE outbox_delivery_receipts SET
          status = 'failed', claim_expires_at = ?, last_error_code = ?
         WHERE outbox_id = ? AND message_id = ? AND status = 'processing'`,
        updatedAt,
        errorCode,
        outboxId,
        messageId,
      ).run();
    } catch (error) {
      throw databaseConflict(error);
    }
  }
}

function outboxStateConflict(outboxId: string, expectedStatus: string): AccessControlError {
  return new AccessControlError(
    409,
    'outbox_state_conflict',
    `Outbox record ${outboxId} is no longer ${expectedStatus}.`,
  );
}
