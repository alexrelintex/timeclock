/**
 * OpenAPI 3.1 description of the Time-Clock HTTP API — the integration contract a
 * host CRM / HRIS builds against. Served as JSON at GET /openapi.json and rendered
 * at GET /docs. Kept hand-authored (not generated) so it reads as a contract; when
 * you add or change a route in server.ts, update the matching operation here.
 *
 * Auth model (see securitySchemes):
 *   - identityJwt  Most /api/* endpoints. The host BACKEND mints a short-lived
 *                  HS256 JWT ({iss:tenant, sub:hostUserId, email?, role?, exp<=5m})
 *                  signed with the shared TIMECLOCK_IDENTITY_SECRET and sends it as
 *                  `Authorization: Bearer <jwt>`. Role is clamped to min(claim,
 *                  stored). See apps/api/src/identity.ts.
 *   - webhookHmac  POST /webhooks/hris only. HMAC-SHA256 of the raw body with
 *                  TIMECLOCK_WEBHOOK_SECRET, sent as `x-hris-signature`.
 *   - Dev endpoints (/api/dev/*) exist only when NODE_ENV!=production.
 */

type Json = Record<string, unknown>;

const ROLE = { type: 'string', enum: ['admin', 'manager', 'supervisor', 'user'] };
const PUNCH_TYPE = {
  type: 'string',
  enum: ['IN', 'OUT', 'BREAK_START', 'BREAK_END', 'LUNCH_START', 'LUNCH_END'],
};

const bearer = [{ identityJwt: [] as string[] }];

export function buildOpenApiSpec(version: string): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Time-Clock API',
      version,
      description:
        'Embeddable clock-in/out widget + HRIS-agnostic compliance/time service.\n\n' +
        '**Connecting a CRM.** The host backend mints a short-lived signed identity JWT ' +
        '(`{iss: tenantId, sub: hostUserId, email?, role?, exp}`, HS256 with the shared ' +
        '`TIMECLOCK_IDENTITY_SECRET`) and passes it as `Authorization: Bearer <jwt>`. On a ' +
        '`hostUserId` not seen before, an `email` claim links the CRM user to an existing ' +
        'employee once (connect-by-email); later logins use the id. Time-Clock stays its own ' +
        'system of record — no cross-schema foreign keys out to any CRM.\n\n' +
        '**Embed.** A one-line loader (`GET /loader.js`) drops the widget into the host page ' +
        'and brokers the token via postMessage.\n\n' +
        '**HRIS.** Employee.Created/Modified events arrive at `POST /webhooks/hris` (HMAC ' +
        'signed); per-tenant connectors are configured under `/api/admin/hris`.',
    },
    servers: [{ url: '/', description: 'This instance' }],
    tags: [
      { name: 'Health', description: 'Liveness / readiness.' },
      { name: 'Agent', description: 'The clocked-in employee (identity JWT).' },
      { name: 'Supervisor', description: 'Board, history, exports (role manager/supervisor/admin).' },
      { name: 'Scheduling', description: 'Weekly patterns, per-date overrides, forecast.' },
      { name: 'Employees', description: 'Directory management + HRIS linkage (supervisor+).' },
      { name: 'HRIS Admin', description: 'Per-tenant connector configuration (admin only).' },
      { name: 'Webhooks', description: 'Inbound HRIS events (HMAC signed).' },
      { name: 'Embed', description: 'Widget loader + hosted UIs.' },
      { name: 'Dev', description: 'Demo helpers — present only when NODE_ENV!=production.' },
    ],
    components: {
      responses: {
        Unauthorized: { description: 'Missing or invalid identity token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        Forbidden: { description: 'Caller lacks the required role/department scope', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        BadRequest: { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        NotFound: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
      securitySchemes: {
        identityJwt: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Host-minted identity JWT (HS256, ' +
            '`{iss:tenantId, sub:hostUserId, email?, role?, exp}`).',
        },
        webhookHmac: {
          type: 'apiKey',
          in: 'header',
          name: 'x-hris-signature',
          description: 'Hex/base64 HMAC-SHA256 of the raw request body using TIMECLOCK_WEBHOOK_SECRET.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' }, code: { type: 'string' } },
          required: ['error'],
        },
        Health: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            tenants: { type: 'integer' },
            version: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['ok'],
        },
        IdentityClaims: {
          type: 'object',
          description: 'The payload the host signs into the identity JWT.',
          properties: {
            iss: { type: 'string', description: 'Tenant id (issuer).' },
            sub: { type: 'string', description: 'Host CRM user id.' },
            email: { type: 'string', format: 'email', description: 'Optional connection key.' },
            role: ROLE,
            exp: { type: 'integer', description: 'Expiry (epoch seconds); <= 5 min out.' },
          },
          required: ['iss', 'sub', 'exp'],
        },
        PunchRequest: {
          type: 'object',
          properties: { type: PUNCH_TYPE, note: { type: 'string', maxLength: 300 } },
          required: ['type'],
        },
        AgentView: {
          type: 'object',
          description: 'The agent read model (times in the employee\'s own timezone).',
          properties: {
            agentId: { type: 'string' },
            displayName: { type: 'string' },
            department: { type: 'string' },
            timezone: { type: 'string', description: 'IANA zone.' },
            status: { type: 'string', enum: ['CLOCKED_OUT', 'ACTIVE', 'ON_BREAK', 'ON_LUNCH'] },
            shiftStart: { type: ['string', 'null'], format: 'date-time' },
            workedMs: { type: 'integer' },
            mealPremiumState: { type: 'boolean' },
            clockoutCorrection: {
              type: ['object', 'null'],
              properties: {
                shiftStart: { type: 'string', format: 'date-time' },
                ageMs: { type: 'integer' },
                suggestedClockout: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        PunchResult: {
          type: 'object',
          properties: {
            eventId: { type: 'string' },
            newStatus: { type: 'string' },
            enqueuedToHris: { type: 'boolean' },
            view: { $ref: '#/components/schemas/AgentView' },
          },
        },
        Employee: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: 'string' },
            department: { type: 'string' },
            locationState: { type: 'string', description: 'USPS work-state code (CA, TX, …).' },
            timezone: { type: 'string' },
            role: ROLE,
            managedDepartments: { type: 'array', items: { type: 'string' } },
            hostUserId: { type: 'string' },
            email: { type: ['string', 'null'], format: 'email' },
            hrisEmployeeId: { type: ['string', 'null'] },
            active: { type: 'boolean' },
          },
        },
        EmployeeCreate: {
          type: 'object',
          properties: {
            displayName: { type: 'string' },
            department: { type: 'string' },
            locationState: { type: 'string' },
            timezone: { type: 'string' },
            role: ROLE,
            managedDepartments: { type: 'array', items: { type: 'string' } },
            hostUserId: { type: 'string' },
            email: { type: 'string', format: 'email' },
          },
          required: ['displayName', 'department'],
        },
        HrisConfig: {
          type: 'object',
          properties: {
            provider: { type: ['string', 'null'], enum: ['none', 'mock', 'paycor', 'gusto', null] },
            config: { type: 'object', additionalProperties: true, description: 'Provider-specific; secrets are write-only and returned masked.' },
          },
        },
        WebhookEvent: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['Employee.Created', 'Employee.Modified'] },
            tenantId: { type: 'string' },
            employee: {
              type: 'object',
              properties: {
                hrisEmployeeId: { type: 'string' },
                hostUserId: { type: 'string' },
                email: { type: 'string', format: 'email' },
                departmentId: { type: 'string' },
                activityTypeId: { type: 'string' },
                active: { type: 'boolean' },
              },
            },
          },
          required: ['type'],
        },
      },
    },
    security: bearer,
    paths: {
      '/healthz': {
        get: {
          tags: ['Health'],
          summary: 'Liveness / readiness',
          security: [],
          responses: {
            '200': { description: 'Healthy', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } },
          },
        },
      },
      '/openapi.json': {
        get: { tags: ['Health'], summary: 'This OpenAPI document', security: [], responses: { '200': { description: 'OpenAPI 3.1 spec' } } },
      },
      '/api/me': {
        get: {
          tags: ['Agent'],
          summary: 'Current agent read model',
          responses: {
            '200': { description: 'Agent view', content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentView' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },
      '/api/me/stream': {
        get: {
          tags: ['Agent'],
          summary: 'Agent view live updates (SSE)',
          description: 'text/event-stream; emits `update` events carrying an AgentView.',
          responses: { '200': { description: 'Event stream', content: { 'text/event-stream': {} } }, '401': { $ref: '#/components/responses/Unauthorized' } },
        },
      },
      '/api/punch': {
        post: {
          tags: ['Agent'],
          summary: 'Record a punch (clock in/out, break, lunch)',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PunchRequest' } } } },
          responses: {
            '200': { description: 'Punch recorded', content: { 'application/json': { schema: { $ref: '#/components/schemas/PunchResult' } } } },
            '400': { description: 'Invalid punch type', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '409': {
              description: 'Invalid state transition, or a missing clock-out must be filed first (code ORPHAN_CLOCKOUT_REQUIRED / INVALID_TRANSITION).',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/clockout-correction': {
        post: {
          tags: ['Agent'],
          summary: 'File an estimated clock-out for an orphaned shift',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { estimatedClockout: { type: 'string', format: 'date-time' }, reason: { type: 'string' } }, required: ['estimatedClockout', 'reason'] } } } },
          responses: { '200': { description: 'Correction filed' }, '400': { $ref: '#/components/responses/BadRequest' }, '401': { $ref: '#/components/responses/Unauthorized' } },
        },
      },
      '/api/history': {
        get: { tags: ['Agent'], summary: "The agent's own punch history", parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { '200': { description: 'Events for the date' }, '401': { $ref: '#/components/responses/Unauthorized' } } },
      },
      '/api/me/schedule': {
        get: { tags: ['Scheduling'], summary: "The agent's own schedule", responses: { '200': { description: 'Planned shifts' }, '401': { $ref: '#/components/responses/Unauthorized' } } },
      },
      '/api/supervisor/snapshot': {
        get: { tags: ['Supervisor'], summary: 'Live board snapshot (scoped to managed departments)', responses: { '200': { description: 'Supervisor snapshot' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/stream': {
        get: { tags: ['Supervisor'], summary: 'Board live updates (SSE)', responses: { '200': { description: 'Event stream', content: { 'text/event-stream': {} } }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/history': {
        get: { tags: ['Supervisor'], summary: 'Department punch history', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'department', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Events' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/export/punches': {
        get: {
          tags: ['Supervisor'],
          summary: 'Export punches as CSV (scoped to managed departments)',
          parameters: [{ name: 'department', in: 'query', schema: { type: 'string' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }],
          responses: { '200': { description: 'CSV', content: { 'text/csv': {} } }, '403': { $ref: '#/components/responses/Forbidden' } },
        },
      },
      '/api/supervisor/schedule': {
        get: { tags: ['Scheduling'], summary: 'Team schedule', responses: { '200': { description: 'Schedule' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/schedule/pattern': {
        post: { tags: ['Scheduling'], summary: "Replace an agent's weekly pattern", requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { agentId: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } } }, required: ['agentId', 'rows'] } } } }, responses: { '200': { description: 'Saved' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/schedule/day': {
        post: { tags: ['Scheduling'], summary: 'Set a per-date schedule exception', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: 'Saved' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/schedule/day/clear': {
        post: { tags: ['Scheduling'], summary: 'Clear a per-date schedule exception', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { agentId: { type: 'string' }, date: { type: 'string', format: 'date' } }, required: ['agentId', 'date'] } } } }, responses: { '200': { description: 'Cleared' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/forecast': {
        get: { tags: ['Scheduling'], summary: 'Cached coverage/overtime forecast', responses: { '200': { description: 'Forecast' }, '403': { $ref: '#/components/responses/Forbidden' } } },
        post: { tags: ['Scheduling'], summary: 'Recompute the forecast on demand', responses: { '200': { description: 'Forecast' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/employees': {
        get: { tags: ['Employees'], summary: 'List employees (scoped)', responses: { '200': { description: 'Employees', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Employee' } } } } }, '403': { $ref: '#/components/responses/Forbidden' } } },
        post: { tags: ['Employees'], summary: 'Create an employee (local or HRIS-synced)', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/EmployeeCreate' } } } }, responses: { '200': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Employee' } } } }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/employees/{id}': {
        post: { tags: ['Employees'], summary: 'Edit an employee', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/EmployeeCreate' } } } }, responses: { '200': { description: 'Updated' }, '404': { $ref: '#/components/responses/NotFound' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/employees/{id}/active': {
        post: { tags: ['Employees'], summary: 'Deactivate (soft-delete) / reactivate', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { active: { type: 'boolean' } } } } } }, responses: { '200': { description: 'Toggled' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/employees/{id}/archive': {
        post: { tags: ['Employees'], summary: 'Archive a deactivated employee (data retained)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Archived' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/employees/{id}/unarchive': {
        post: { tags: ['Employees'], summary: 'Unarchive an employee', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Unarchived' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/employees/{id}/hris': {
        post: { tags: ['Employees'], summary: 'Link/unlink an employee to an HRIS record', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { hrisEmployeeId: { type: ['string', 'null'] } } } } } }, responses: { '200': { description: 'Linked' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/employees/pull-hris': {
        post: { tags: ['Employees'], summary: 'Pull employees from the tenant HRIS connector', responses: { '200': { description: 'Pulled' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/supervisor/employees/run-archival': {
        post: { tags: ['Employees'], summary: 'Archive everyone past the 90-day deactivation window', responses: { '200': { description: 'Archived count' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/exceptions/{id}/resolve': {
        post: { tags: ['Supervisor'], summary: 'Resolve a compliance exception', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { resolution: { type: 'string' } } } } } }, responses: { '200': { description: 'Resolved' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/admin/hris/catalog': {
        get: { tags: ['HRIS Admin'], summary: 'Available HRIS connectors', responses: { '200': { description: 'Connector catalog' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/api/admin/hris': {
        get: { tags: ['HRIS Admin'], summary: "This tenant's HRIS config (secrets masked)", responses: { '200': { description: 'Config', content: { 'application/json': { schema: { $ref: '#/components/schemas/HrisConfig' } } } }, '403': { $ref: '#/components/responses/Forbidden' } } },
        post: { tags: ['HRIS Admin'], summary: 'Set this tenant\'s HRIS connector + config', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/HrisConfig' } } } }, responses: { '200': { description: 'Saved' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      },
      '/webhooks/hris': {
        post: {
          tags: ['Webhooks'],
          summary: 'Inbound HRIS employee event',
          description: 'HMAC-signed. Employee.Created/Modified keep the identity map + HRIS ids in sync; matched by hrisEmployeeId, then hostUserId, then email.',
          security: [{ webhookHmac: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookEvent' } } } },
          responses: { '200': { description: 'Matched + applied' }, '202': { description: 'Accepted, no match' }, '401': { description: 'Bad signature', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
        },
      },
      '/loader.js': {
        get: { tags: ['Embed'], summary: 'One-line embed loader script', security: [], responses: { '200': { description: 'JavaScript', content: { 'text/javascript': {} } } } },
      },
      '/api/dev/token': {
        get: {
          tags: ['Dev'],
          summary: 'Mint a demo identity token (NODE_ENV!=production only)',
          description: 'Mirrors how a host backend signs a token. `?user=<hostUserId>` or `?email=<addr>` (connect-by-email).',
          security: [],
          parameters: [{ name: 'user', in: 'query', schema: { type: 'string' } }, { name: 'email', in: 'query', schema: { type: 'string', format: 'email' } }, { name: 'tenant', in: 'query', schema: { type: 'string' } }],
          responses: { '200': { description: 'Token', content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' }, role: ROLE, hostUserId: { type: 'string' }, connectedBy: { type: 'string', enum: ['id', 'email'] } } } } } }, '404': { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/api/dev/agents': {
        get: { tags: ['Dev'], summary: 'Demo roster (NODE_ENV!=production only)', security: [], parameters: [{ name: 'tenant', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Agents' } } },
      },
    },
  };
}
