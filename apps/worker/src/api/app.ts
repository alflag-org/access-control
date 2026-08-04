import { OpenAPIHono, type OpenAPIHonoOptions } from '@hono/zod-openapi';
import { SwaggerUI, type SwaggerUIOptions } from '@hono/swagger-ui';
import { bodyLimit } from 'hono/body-limit';
import { ZodError } from 'zod';
import { AccessControlError } from '@access-control/domain';
import { renderUiPage } from '../ui/app';
import { renderAccessRequiredShell } from '../ui/components/shell';
import { progressiveFormsScript } from '../ui/client/forms';
import type { DeploymentEnvironment, WorkerEnvironment } from './environment';
import { registerApiRoutes } from './routes';
import { mutationOrigin, requestContext, requireSubject } from './security';

const MAX_JSON_BODY_BYTES = 1_048_576;

const openApiConfiguration = {
  openapi: '3.1.0' as const,
  info: {
    title: 'Access Control API',
    version: '1.0.0',
    description:
      'Access-governance, application-portal, declarative configuration, and provisioning control-plane API. Authentication remains external to Access Control.',
  },
  tags: [
    { name: 'Authentication', description: 'Verified Cloudflare Access session mapping.' },
    { name: 'Portal', description: 'Current Subject applications, access, and provider accounts.' },
    { name: 'Subjects', description: 'Governed people, services, and external identities.' },
    { name: 'Guests', description: 'Sponsored managed guests with mandatory expiration.' },
    {
      name: 'Configuration',
      description: 'Declaratively managed runtime settings, connections, and targets.',
    },
    {
      name: 'Directory',
      description: 'Complete Google Directory snapshots and direct group members.',
    },
    { name: 'Applications', description: 'Application catalog and immutable entitlement keys.' },
    {
      name: 'Mappings',
      description: 'Source-group mappings and affected-Subject activation previews.',
    },
    {
      name: 'Provisioning',
      description: 'Observed state, immutable plans, and explicit operations.',
    },
    { name: 'Audit', description: 'Append-only mutation evidence.' },
    { name: 'Exports', description: 'Portable schema-versioned recovery exports.' },
  ],
};

const openApiOptions: OpenAPIHonoOptions<WorkerEnvironment> = {
  defaultHook: (result) => {
    if (result.success) return;
    throw new AccessControlError(
      400,
      'invalid_request',
      'Request validation failed.',
      result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  },
};

export function createApp(): OpenAPIHono<WorkerEnvironment> {
  const app = new OpenAPIHono<WorkerEnvironment>(openApiOptions);
  app.use('*', requestContext);
  app.use('*', mutationOrigin);
  app.use('*', async (context, next) => {
    await next();
    applySecurityHeaders(context.res, new URL(context.req.url).pathname);
  });
  app.use(
    '/api/v1/*',
    bodyLimit({
      maxSize: MAX_JSON_BODY_BYTES,
      onError: () => {
        throw new AccessControlError(
          400,
          'request_too_large',
          'JSON request bodies are limited to 1 MiB.',
        );
      },
    }),
  );

  app.get('/', (context) => context.redirect('/applications', 302));
  app.get('/healthz', (context) => {
    requireSubject(context);
    return context.json({ status: 'ok' });
  });
  registerApiRoutes(app);

  app.get('/assets/forms.js', (context) => {
    return context.body(progressiveFormsScript, 200, {
      'content-type': 'text/javascript; charset=UTF-8',
      'cache-control': 'no-store',
    });
  });

  app.get('/access-required', (context) => {
    if (context.get('subject') !== null) return context.redirect('/applications', 302);
    const principal = context.get('accessPrincipal');
    return context.html(
      renderAccessRequiredShell({
        issuer: principal.issuer,
        providerSubject: principal.providerSubject,
        canonicalIdentity: principal.canonicalIdentity,
      }),
    );
  });

  app.get('/openapi.json', (context) => {
    requireSubject(context);
    return context.json(createOpenApiDocument(app));
  });
  app.get('/docs', (context) => {
    requireSubject(context);
    return context.html(renderSwaggerUiDocument(context.env.ENVIRONMENT));
  });

  for (const path of [
    '/applications',
    '/access',
    '/account',
    '/admin/people',
    '/admin/guests',
    '/admin/applications',
    '/admin/groups',
    '/admin/mappings',
    '/admin/provisioning',
    '/admin/audit',
    '/admin/settings',
  ]) {
    app.get(path, async (context) => {
      const subject = requireSubject(context);
      const html = await renderUiPage({
        pathname: new URL(context.req.url).pathname,
        subject,
        roles: context.get('roles'),
        repositories: context.get('repositories'),
      });
      if (html === null) throw new AccessControlError(404, 'not_found', 'Page not found.');
      return context.html(html);
    });
  }

  app.onError((error, context) => {
    const normalized = normalizeError(error);
    console.error(
      JSON.stringify({
        requestId: context.get('requestId'),
        errorCode: normalized.code,
        status: normalized.status,
      }),
    );
    return context.json(
      {
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.violations.length === 0 ? {} : { violations: normalized.violations }),
        },
        requestId: context.get('requestId'),
      },
      normalized.status,
    );
  });
  app.notFound((context) =>
    context.json(
      {
        error: { code: 'not_found', message: 'Route not found.' },
        requestId: context.get('requestId'),
      },
      404,
    ),
  );

  app.openAPIRegistry.registerComponent('securitySchemes', 'CloudflareAccess', {
    type: 'apiKey',
    in: 'header',
    name: 'Cf-Access-Jwt-Assertion',
    description:
      'Cloudflare Access injects this JWT at the edge. Browser users rely on their same-origin Access session and do not paste tokens into documentation.',
  });
  return app;
}

export function createOpenApiDocument(app: OpenAPIHono<WorkerEnvironment> = createApp()) {
  return app.getOpenAPI31Document(openApiConfiguration);
}

export function swaggerUiOptions(environment: DeploymentEnvironment): SwaggerUIOptions {
  return {
    title: 'Access Control API',
    url: '/openapi.json',
    version: '5.32.11',
    deepLinking: true,
    filter: true,
    displayRequestDuration: true,
    showExtensions: true,
    persistAuthorization: false,
    withCredentials: true,
    requestInterceptor:
      "(request) => { if (request.headers) { delete request.headers['Cf-Access-Jwt-Assertion']; delete request.headers['cf-access-jwt-assertion']; } return request; }",
    ...(environment === 'development' ? {} : { supportedSubmitMethods: [] }),
  };
}

function renderSwaggerUiDocument(environment: DeploymentEnvironment): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Access Control API reference"><link rel="icon" href="data:,"><title>Access Control API</title><style>.swagger-ui .auth-wrapper,.swagger-ui .authorization__btn{display:none!important}</style></head><body>${SwaggerUI(swaggerUiOptions(environment))}</body></html>`;
}

function normalizeError(error: unknown): AccessControlError {
  if (error instanceof AccessControlError) return error;
  if (error instanceof ZodError) {
    return new AccessControlError(
      422,
      'validation_failed',
      'The value does not match the domain contract.',
      error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  if (error instanceof SyntaxError) {
    return new AccessControlError(400, 'malformed_json', 'The JSON request body is malformed.');
  }
  return new AccessControlError(503, 'internal_error', 'The request could not be completed.');
}

function applySecurityHeaders(response: Response, pathname: string): void {
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'same-origin');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('permissions-policy', 'camera=(), geolocation=(), microphone=()');
  response.headers.set('cache-control', 'no-store');
  const docs = pathname === '/docs';
  response.headers.set(
    'content-security-policy',
    `default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'${docs ? " 'unsafe-inline'" : ''}; style-src 'unsafe-inline'`,
  );
}
