import { createGuestProfileCandidate } from '@access-control/domain';
import { createMutationRecords, type MutationContext } from './events';
import type { IdentityRepository } from './ports';
import type { ServiceRuntime } from './runtime';

export class GuestExpirationService {
  public constructor(
    private readonly repository: IdentityRepository,
    private readonly runtime: ServiceRuntime,
  ) {}

  public async processExpiredGuests(context: MutationContext): Promise<number> {
    const processedAt = this.runtime.now();
    const expired = (await this.repository.listGuestProfiles()).filter(
      (guest) =>
        guest.status !== 'expired' &&
        guest.status !== 'retired' &&
        Date.parse(guest.expiresAt) <= Date.parse(processedAt),
    );
    for (const current of expired) {
      const guest = createGuestProfileCandidate({
        ...current,
        status: 'expired',
        revision: current.revision + 1,
        updatedAt: processedAt,
        updatedBy: current.updatedBy,
      });
      await this.repository.expireManagedGuestAccess(
        guest,
        createMutationRecords(this.runtime, context, {
          eventType: 'access-control.guest.expired',
          topic: 'access-control.guest.expired',
          targetType: 'guest_profile',
          targetId: guest.subjectId,
          action: 'expire_access',
          previousRevision: current.revision,
          resultingRevision: guest.revision,
          payload: { expiresAt: guest.expiresAt, desiredAccess: 'absent' },
        }),
        current.revision,
      );
    }
    return expired.length;
  }
}
