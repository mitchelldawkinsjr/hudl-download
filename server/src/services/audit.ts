// Audit event writer. Every privileged/state-changing action records an
// audit_events row. Never throws into the request path — audit failures are
// logged but do not block the operation (best-effort, since the operation
// itself has already happened).
import { query } from '../db/client.js';

export interface AuditInput {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    await query(
      `insert into audit_events (actor_id, action, entity_type, entity_id, before_json, after_json, request_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.actorId ?? null,
        input.action,
        input.entityType,
        input.entityId ?? null,
        input.before === undefined || input.before === null ? null : JSON.stringify(input.before),
        input.after === undefined || input.after === null ? null : JSON.stringify(input.after),
        input.requestId ?? null,
      ],
      { tag: 'audit.write' }
    );
  } catch (err) {
    console.error('[audit] failed to write:', err instanceof Error ? err.message : err);
  }
}
