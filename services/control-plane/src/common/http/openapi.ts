import type { INestApplication } from '@nestjs/common';
import {
  ApiProperty,
  ApiPropertyOptional,
  DocumentBuilder,
  getSchemaPath,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';

import type { ErrorBody } from '../errors/error.filter';

/** Swagger UI; the JSON document is at `${DOCS_PATH}-json`. */
export const DOCS_PATH = 'api/docs';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

class ErrorDetail {
  @ApiProperty({
    example: 'tenant_not_found',
    description: 'Stable machine-readable code (CLAUDE.md §18.3.2)',
  })
  code!: string;

  @ApiProperty({ example: 'Tenant not found' })
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'validation_failed: [{field, messages[]}]; upstream_*: {service}',
  })
  details?: unknown;
}

export class ErrorResponse implements ErrorBody {
  @ApiProperty({ type: ErrorDetail })
  error!: ErrorDetail;

  @ApiPropertyOptional({ description: 'Also sent as the X-Request-Id header' })
  requestId?: string;
}

const DESCRIPTION = `Control-plane of MTCO (multi-tenant cloud observability).

- Authenticate with a Keycloak access token of realm \`observability\`
  (\`Authorization: Bearer …\`); \`tools/mtco\` does this for you.
- Role and tenant come from the control-plane database, not from the token:
  disabling a user blocks its very next request.
- Tenants are addressed by their key; users, agents and grants by UUID.
- Every error has the shape \`{"error":{"code","message","details?"},"requestId"}\`.`;

/**
 * Builds the OpenAPI document from the controllers' decorators. Every
 * operation gets the error envelope as its `default` response, so the
 * controllers only declare their success responses.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('MTCO control-plane API')
    .setDescription(DESCRIPTION)
    .setVersion('1')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Keycloak access token (realm observability)',
    })
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [ErrorResponse],
  });

  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];

      if (operation) {
        operation.responses.default = {
          description: 'Error',
          content: {
            'application/json': {
              schema: { $ref: getSchemaPath(ErrorResponse) },
            },
          },
        };
      }
    }
  }

  return document;
}

/** Swagger UI at /api/docs and the JSON at /api/docs-json (public). */
export function serveOpenApi(app: INestApplication): void {
  SwaggerModule.setup(DOCS_PATH, app, () => buildOpenApiDocument(app), {
    jsonDocumentUrl: `${DOCS_PATH}-json`,
    raw: ['json'],
  });
}
