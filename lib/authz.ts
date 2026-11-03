import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { permissions, rolesPermissions, roles, userRoles } from "@/db/schema";

export type Access = { roles: string[]; permissions: string[] };

/** Loads a user's roles and the union of their permission keys (one query). */
export async function getUserAccess(userId: string): Promise<Access> {
  const rows = await getDb()
    .select({ role: roles.name, permission: permissions.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .leftJoin(rolesPermissions, eq(rolesPermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolesPermissions.permissionId))
    .where(eq(userRoles.userId, userId));

  return {
    roles: [...new Set(rows.map((r) => r.role))],
    permissions: [...new Set(rows.flatMap((r) => (r.permission ? [r.permission] : [])))],
  };
}

export const can = (access: Pick<Access, "permissions">, key: string) =>
  access.permissions.includes(key);