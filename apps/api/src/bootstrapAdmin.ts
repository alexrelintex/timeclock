/**
 * Default-admin bootstrap. On every boot, ensure an admin agent exists on each
 * tenant for BOOTSTRAP_ADMIN_EMAIL (defaults to alex@sysapp.ai) so no instance can
 * come up without the standing admin. Set the env var empty or to "none" to
 * disable. Idempotent: promotes an existing agent with that email to admin, or
 * creates one. The email IS the identity — hostUserId is set to the email, so the
 * host CRM mints an identity JWT with sub/email = that address to get admin.
 */
import { randomUUID } from 'node:crypto';
import type { Store } from './store/contract.js';
import type { Agent } from './types.js';
import { normalizeEmail } from './identity.js';

const DEFAULT_ADMIN_EMAIL = 'alex@sysapp.ai';

export async function ensureBootstrapAdmin(db: Store): Promise<{ created: number; promoted: number }> {
  const raw = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const wanted = raw === undefined ? DEFAULT_ADMIN_EMAIL : raw.trim();
  if (!wanted || wanted.toLowerCase() === 'none') return { created: 0, promoted: 0 };

  const email = normalizeEmail(wanted);
  if (!email) {
    console.warn(`[bootstrap-admin] BOOTSTRAP_ADMIN_EMAIL='${wanted}' is not a valid email — skipping`);
    return { created: 0, promoted: 0 };
  }
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || titleCase(email.split('@')[0]);

  let created = 0;
  let promoted = 0;
  const tenants = db.listTenants();
  for (const tenant of tenants) {
    const existing = db.agentByEmail(tenant.id, email);
    if (existing) {
      // Already present — make sure it is a full admin (and reachable by id).
      if (existing.role !== 'admin' || existing.isSupervisor !== true || !existing.hostUserId) {
        db.upsertAgent({
          ...existing,
          role: 'admin',
          isSupervisor: true,
          hostUserId: existing.hostUserId || email,
          email,
        });
        promoted += 1;
      }
    } else {
      const agent: Agent = {
        id: randomUUID(),
        tenantId: tenant.id,
        displayName: name,
        department: 'Admin',
        locationState: 'CA',
        timezone: tenant.timezone,
        role: 'admin',
        isSupervisor: true,
        managedDepartments: undefined,
        hostUserId: email, // the email is the identity key
        email,
        hrisEmployeeId: null,
        hrisDepartmentId: null,
        hrisActivityTypeId: null,
        mealWaiverOnFile: false,
        active: true,
      };
      db.upsertAgent(agent);
      created += 1;
    }
  }

  if (created || promoted) {
    console.log(
      `[bootstrap-admin] ${email}: created ${created}, promoted ${promoted} across ${tenants.length} tenant(s)`,
    );
  }
  // Make sure the writes reached a durable store before the server serves.
  await db.flush?.();
  return { created, promoted };
}

function titleCase(s: string): string {
  const out = s.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  return out || s;
}
