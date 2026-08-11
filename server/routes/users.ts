import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, count, desc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, pivotUsersProjects } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { defaultProjectRoleForUserRole, hasProjectPermission } from '../middleware/permissions.js';
import { hashPassword } from '../services/auth.js';
import { randomUUID } from 'node:crypto';
import { NotFoundError, ConflictError, ForbiddenError } from '../lib/errors.js';
import {
  createUserSchema, updateUserSchema,
  getUserSchema, deleteUserSchema, listUsersSchema,
} from '../lib/schemas.js';
import { logAudit, getClientIp } from '../services/audit.js';

function stripPassword(user: typeof users.$inferSelect) {
  const { passwordHash: _, ...rest } = user;
  return rest;
}

function getOwnedProjectIds(user: typeof users.$inferSelect): string[] | null {
  if (user.role === 'admin') return null;
  return db.select({ projectId: pivotUsersProjects.projectId })
    .from(pivotUsersProjects)
    .where(eq(pivotUsersProjects.userId, user.id))
    .all()
    .filter((pivot) => hasProjectPermission(user.id, user.role, pivot.projectId, 'manage_members'))
    .map((pivot) => pivot.projectId);
}

function getUserProjectRoles(userId: string) {
  return db.select().from(pivotUsersProjects)
    .where(eq(pivotUsersProjects.userId, userId))
    .all();
}

function serializeUser(user: typeof users.$inferSelect, pivots = getUserProjectRoles(user.id)) {
  return {
    ...stripPassword(user),
    projectRoles: pivots.map((p) => ({ projectId: p.projectId, role: p.role })),
  };
}

function assertCanManageProjectRoles(currentUser: typeof users.$inferSelect, projectRoles: Array<{ projectId: string }>): void {
  if (currentUser.role === 'admin') return;
  for (const projectRole of projectRoles) {
    if (!hasProjectPermission(currentUser.id, currentUser.role, projectRole.projectId, 'manage_members')) {
      throw new ForbiddenError('Нет прав управлять участниками этого проекта', 'NO_PROJECT_PERMISSION');
    }
  }
}

function assertCanViewUser(currentUser: typeof users.$inferSelect, targetUserId: string): void {
  if (currentUser.role === 'admin' || currentUser.id === targetUserId) return;
  assertCanManageUser(currentUser, targetUserId);
}

function assertCanManageUser(currentUser: typeof users.$inferSelect, targetUserId: string): void {
  if (currentUser.role === 'admin') return;
  const manageableProjectIds = getOwnedProjectIds(currentUser) ?? [];
  if (manageableProjectIds.length === 0) throw new ForbiddenError('Нет прав управлять пользователями', 'NO_PROJECT_PERMISSION');
  const targetProjectIds = getUserProjectRoles(targetUserId).map((pivot) => pivot.projectId);
  if (!targetProjectIds.some((projectId) => manageableProjectIds.includes(projectId))) {
    throw new ForbiddenError('Нет прав управлять этим пользователем', 'NO_PROJECT_PERMISSION');
  }
}

export const userRoutes = new Hono()
  .use('/*', authMiddleware)
  .use('/*', async (c, next) => {
    if (c.get('apiKey')) throw new ForbiddenError('API keys cannot manage users', 'FORBIDDEN');
    await next();
  })

  // CREATE
  .post('/create',
    zValidator('json', createUserSchema),
    async (c) => {
      const { email, password, name, role, projectRoles } = c.req.valid('json');
      const currentUser = c.get('user');

      if (currentUser.role !== 'admin' && role === 'admin') {
        throw new ForbiddenError('Нет прав создавать администратора', 'FORBIDDEN');
      }
      if (currentUser.role !== 'admin' && projectRoles.length === 0) {
        throw new ForbiddenError('Нет прав управлять пользователями', 'NO_PROJECT_PERMISSION');
      }
      assertCanManageProjectRoles(currentUser, projectRoles);

      // Check unique email
      const existing = db.select().from(users).where(eq(users.email, email)).get();
      if (existing) throw new ConflictError(`User with email '${email}' already exists`, 'DUPLICATE_EMAIL');

      const id = randomUUID();
      const passwordHash = await hashPassword(password);

      // Transaction: insert user + pivot entries atomically
      const { user, pivots } = db.transaction((tx) => {
        tx.insert(users).values({ id, email, passwordHash, name, role }).run();

        for (const projectRole of projectRoles) {
          tx.insert(pivotUsersProjects).values({ userId: id, projectId: projectRole.projectId, role: projectRole.role }).run();
        }

        const createdUser = tx.select().from(users).where(eq(users.id, id)).get()!;
        const createdPivots = tx.select().from(pivotUsersProjects)
          .where(eq(pivotUsersProjects.userId, id)).all();
        return { user: createdUser, pivots: createdPivots };
      });

      logAudit({ userId: currentUser.id, action: 'create_user', entityType: 'user', entityId: id, details: { email, role }, ipAddress: getClientIp(c) });

      return c.json({
        data: serializeUser(user, pivots),
      }, 201);
    })

  // LIST
  .post('/list',
    zValidator('json', listUsersSchema),
    async (c) => {
      const { projectId, page, perPage } = c.req.valid('json');
      const currentUser = c.get('user');
      const manageableProjectIds = getOwnedProjectIds(currentUser);

      if (manageableProjectIds !== null && manageableProjectIds.length === 0) {
        throw new ForbiddenError('Нет прав управлять пользователями', 'NO_PROJECT_PERMISSION');
      }

      if (projectId && manageableProjectIds !== null && !manageableProjectIds.includes(projectId)) {
        throw new ForbiddenError('Нет прав управлять участниками этого проекта', 'NO_PROJECT_PERMISSION');
      }

      let userList: Array<typeof users.$inferSelect>;
      let total: number;

      if (projectId) {
        // Get users linked to this project (+ all admins)
        const pivotUserIds = db.select({ userId: pivotUsersProjects.userId })
          .from(pivotUsersProjects)
          .where(eq(pivotUsersProjects.projectId, projectId))
          .all()
          .map((p) => p.userId);

        const allUsers = db.select().from(users)
          .orderBy(desc(users.createdAt))
          .all();

        const filtered = allUsers.filter(
          (u) => currentUser.role === 'admin' ? u.role === 'admin' || pivotUserIds.includes(u.id) : pivotUserIds.includes(u.id),
        );
        total = filtered.length;
        userList = filtered.slice((page - 1) * perPage, page * perPage);
      } else {
        if (manageableProjectIds === null) {
          userList = db.select().from(users)
            .orderBy(desc(users.createdAt))
            .limit(perPage)
            .offset((page - 1) * perPage)
            .all();
          const [{ cnt }] = db.select({ cnt: count() }).from(users).all();
          total = cnt;
        } else {
          const manageableUserIds = db.select({ userId: pivotUsersProjects.userId })
            .from(pivotUsersProjects)
            .where(inArray(pivotUsersProjects.projectId, manageableProjectIds))
            .all()
            .map((p) => p.userId);
          const uniqueUserIds = [...new Set(manageableUserIds)];
          if (uniqueUserIds.length === 0) {
            userList = [];
            total = 0;
          } else {
            const filtered = db.select().from(users)
              .where(inArray(users.id, uniqueUserIds))
              .orderBy(desc(users.createdAt))
              .all();
            total = filtered.length;
            userList = filtered.slice((page - 1) * perPage, page * perPage);
          }
        }
      }

      // Attach project access to each user
      const userIds = userList.map((u) => u.id);
      const pivots = userIds.length
        ? db.select().from(pivotUsersProjects)
            .where(inArray(pivotUsersProjects.userId, userIds))
            .all()
        : [];
      const pivotMap = new Map<string, { projectId: string; role: string }[]>();
      for (const p of pivots) {
        const arr = pivotMap.get(p.userId);
        const projectRole = { projectId: p.projectId, role: p.role };
        if (arr) arr.push(projectRole);
        else pivotMap.set(p.userId, [projectRole]);
      }

      return c.json({
        data: {
          items: userList.map((u) => ({
            ...stripPassword(u),
            projectRoles: pivotMap.get(u.id) ?? [],
          })),
          pagination: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
        },
      });
    })

  // GET
  .post('/get',
    zValidator('json', getUserSchema),
    async (c) => {
      const { id } = c.req.valid('json');
      const user = db.select().from(users).where(eq(users.id, id)).get();
      if (!user) throw new NotFoundError('User', 'USER_NOT_FOUND');
      assertCanViewUser(c.get('user'), id);

      const pivots = getUserProjectRoles(id);

      return c.json({
        data: serializeUser(user, pivots),
      });
    })

  // UPDATE
  .post('/update',
    zValidator('json', updateUserSchema),
    async (c) => {
      const { id, name, role, isActive, projectRoles, password } = c.req.valid('json');

      const existing = db.select().from(users).where(eq(users.id, id)).get();
      if (!existing) throw new NotFoundError('User', 'USER_NOT_FOUND');
      const currentUser = c.get('user');
      assertCanManageUser(currentUser, id);

      if (currentUser.role !== 'admin' && (role !== undefined || isActive !== undefined || password !== undefined)) {
        throw new ForbiddenError('Нет прав изменять системные поля пользователя', 'FORBIDDEN');
      }
      if (currentUser.role !== 'admin' && projectRoles !== undefined) {
        assertCanManageProjectRoles(currentUser, projectRoles);
      }

      const updateData: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      if (name !== undefined) updateData.name = name;
      if (role !== undefined) updateData.role = role;
      if (isActive !== undefined) updateData.isActive = isActive;
      if (password !== undefined) updateData.passwordHash = await hashPassword(password);

      // Transaction: update user + rebuild pivots atomically
      const { user, pivots } = db.transaction((tx) => {
        tx.update(users).set(updateData).where(eq(users.id, id)).run();

        // Rebuild pivot if project roles were provided
        if (projectRoles !== undefined) {
          const manageableProjectIds = currentUser.role === 'admin' ? null : getOwnedProjectIds(currentUser) ?? [];
          const retainedPivots = currentUser.role === 'admin'
            ? []
            : tx.select().from(pivotUsersProjects)
                .where(eq(pivotUsersProjects.userId, id))
                .all()
                .filter((pivot) => !manageableProjectIds?.includes(pivot.projectId));
          tx.delete(pivotUsersProjects).where(eq(pivotUsersProjects.userId, id)).run();
          for (const retainedPivot of retainedPivots) {
            tx.insert(pivotUsersProjects).values(retainedPivot).run();
          }
          for (const projectRole of projectRoles) {
            tx.insert(pivotUsersProjects).values({ userId: id, projectId: projectRole.projectId, role: projectRole.role ?? defaultProjectRoleForUserRole(role ?? existing.role) }).run();
          }
        }

        const updatedUser = tx.select().from(users).where(eq(users.id, id)).get()!;
        const updatedPivots = tx.select().from(pivotUsersProjects)
          .where(eq(pivotUsersProjects.userId, id)).all();
        return { user: updatedUser, pivots: updatedPivots };
      });

      logAudit({ userId: currentUser.id, action: 'update_user', entityType: 'user', entityId: id, details: { name, role, isActive }, ipAddress: getClientIp(c) });

      return c.json({
        data: serializeUser(user, pivots),
      });
    })

  // DELETE
  .post('/delete',
    zValidator('json', deleteUserSchema),
    async (c) => {
      const { id } = c.req.valid('json');

      const existing = db.select().from(users).where(eq(users.id, id)).get();
      if (!existing) throw new NotFoundError('User', 'USER_NOT_FOUND');

      // Prevent deleting yourself
      const currentUser = c.get('user');
      if (currentUser.role !== 'admin') {
        throw new ForbiddenError('Только администратор может удалять пользователей', 'FORBIDDEN');
      }
      if (currentUser.id === id) {
        throw new ConflictError('Cannot delete yourself', 'CANNOT_DELETE_SELF');
      }

      db.delete(users).where(eq(users.id, id)).run();
      logAudit({ userId: currentUser.id, action: 'delete_user', entityType: 'user', entityId: id, details: { email: existing.email }, ipAddress: getClientIp(c) });
      return c.json({ data: { success: true } });
    });
