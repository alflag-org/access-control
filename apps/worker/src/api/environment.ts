import type { AccessControlRepositories } from '@access-control/application';
import type { PlatformRole, Subject } from '@access-control/domain';
import type { AccessPrincipal } from '../auth/access';

export type DeploymentEnvironment = 'development' | 'staging' | 'production';

export type WorkerEnvironment = {
  Bindings: Env;
  Variables: {
    accessPrincipal: AccessPrincipal;
    repositories: AccessControlRepositories;
    requestId: string;
    roles: PlatformRole[];
    subject: Subject | null;
  };
};
