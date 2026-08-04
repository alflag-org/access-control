import type { AccessControlRepositories } from '@access-control/application';
import { D1AuditRepository } from './audit';
import { D1CatalogRepository } from './catalog';
import { D1DirectoryRepository } from './directory';
import { D1ExportRepository } from './exports';
import { D1IdentityRepository } from './identities';
import { D1ProvisioningRepository } from './provisioning';

export function createD1Repositories(db: D1Database): AccessControlRepositories {
  return {
    identities: new D1IdentityRepository(db),
    catalog: new D1CatalogRepository(db),
    directory: new D1DirectoryRepository(db),
    provisioning: new D1ProvisioningRepository(db),
    audit: new D1AuditRepository(db),
    exports: new D1ExportRepository(db),
  };
}

export { D1AuditRepository } from './audit';
export { D1CatalogRepository } from './catalog';
export { D1DirectoryRepository } from './directory';
export { D1ExportRepository } from './exports';
export { D1IdentityRepository } from './identities';
export { D1ProvisioningRepository } from './provisioning';
