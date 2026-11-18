
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const permissions = [
  ['dashboard.read', 'dashboard', 'read'],
  ['users.read', 'users', 'read'],
  ['users.create', 'users', 'create'],
  ['users.update', 'users', 'update'],
  ['roles.read', 'roles', 'read'],
  ['roles.manage', 'roles', 'manage'],
  ['audit.read', 'audit', 'read'],
  ['settings.manage', 'settings', 'manage'],
  ['accounts.read', 'accounts', 'read'],
  ['accounts.manage', 'accounts', 'manage'],
  ['content.create', 'content', 'create'],
  ['content.read', 'content', 'read'],
  ['content.update', 'content', 'update'],
  ['content.delete', 'content', 'delete'],
  ['content.approve', 'content', 'approve'],
  ['publishing.schedule', 'publishing', 'schedule'],
  ['analytics.read', 'analytics', 'read'],
  ['leads.read', 'leads', 'read'],
  ['leads.manage', 'leads', 'manage'],
] as const;

const roleMap: Record<string, string[]> = {
  'Super Admin': permissions.map(([key]) => key),

  'Marketing Admin': [
    'dashboard.read',
    'users.read',
    'users.create',
    'users.update',
    'roles.read',
    'audit.read',
    'accounts.read',
    'accounts.manage',
    'content.create',
    'content.read',
    'content.update',
    'content.approve',
    'publishing.schedule',
    'analytics.read',
    'leads.read',
    'leads.manage',
  ],

  'Content Creator': [
    'dashboard.read',
    'accounts.read',
    'content.create',
    'content.read',
    'content.update',
  ],

  'Marketing Manager': [
    'dashboard.read',
    'accounts.read',
    'content.create',
    'content.read',
    'content.update',
    'publishing.schedule',
    'analytics.read',
    'leads.read',
    'leads.manage',
  ],

  Approver: [
    'dashboard.read',
    'content.read',
    'content.approve',
  ],

  Analyst: [
    'dashboard.read',
    'analytics.read',
    'leads.read',
  ],
};

async function main() {
  const name = (
    process.env.BOOTSTRAP_ADMIN_NAME ?? 'GPA Social AI Admin'
  ).trim();

  const email = (
    process.env.BOOTSTRAP_ADMIN_EMAIL ?? ''
  ).trim().toLowerCase();

  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  const rounds = Number(process.env.BCRYPT_ROUNDS ?? 12);

  if (
    !email ||
    password.length < 16 ||
    password.includes('CHANGE_THIS')
  ) {
    throw new Error(
      'Set BOOTSTRAP_ADMIN_EMAIL and a unique BOOTSTRAP_ADMIN_PASSWORD of at least 16 characters before seeding.'
    );
  }

  if (!Number.isInteger(rounds) || rounds < 10 || rounds > 15) {
    throw new Error(
      'BCRYPT_ROUNDS must be an integer between 10 and 15.'
    );
  }

  const passwordHash = await bcrypt.hash(password, rounds);

  await prisma.$transaction(
    async (tx) => {
      const organization = await tx.organization.upsert({
        where: { slug: 'gpa-consultancy' },
        update: {},
        create: {
          name: 'GPA Consultancy',
          slug: 'gpa-consultancy',
          timezone: 'America/Chicago',
          language: 'en-US',
        },
      });

      // Provision all permissions.
      for (const [key, module, action] of permissions) {
        await tx.permission.upsert({
          where: { key },
          update: { module, action },
          create: { key, module, action },
        });
      }

      const permissionRows = await tx.permission.findMany({
        where: {
          key: {
            in: permissions.map(([key]) => key),
          },
        },
        select: {
          id: true,
          key: true,
        },
      });

      const permissionByKey = new Map(
        permissionRows.map((item) => [item.key, item.id])
      );

     
const roleIds = new Map<string, string>();

// Collect role-permission relationships for bulk insertion.
const rolePermissionRows: {
  roleId: string;
  permissionId: string;
}[] = [];

// Provision system roles and collect their permissions.
for (const [roleName, keys] of Object.entries(roleMap)) {
  const role = await tx.role.upsert({
    where: {
      organizationId_name: {
        organizationId: organization.id,
        name: roleName,
      },
    },
    update: {
      isSystem: true,
    },
    create: {
      organizationId: organization.id,
      name: roleName,
      isSystem: true,
    },
  });

  roleIds.set(roleName, role.id);

  for (const key of keys) {
    const permissionId = permissionByKey.get(key);

    if (!permissionId) {
      throw new Error(`Seed permission missing: ${key}`);
    }

    rolePermissionRows.push({
      roleId: role.id,
      permissionId,
    });
  }
}

// Insert all role-permission relationships in one database operation.
await tx.rolePermission.createMany({
  data: rolePermissionRows,
  skipDuplicates: true,
});


      // Synchronize bootstrap password from backend .env.
      const user = await tx.user.upsert({
        where: {
          organizationId_email: {
            organizationId: organization.id,
            email,
          },
        },
        update: {
          name,
          status: 'ACTIVE',
          passwordHash,
        },
        create: {
          organizationId: organization.id,
          name,
          email,
          passwordHash,
          status: 'ACTIVE',
        },
      });

      const superAdminRoleId = roleIds.get('Super Admin');

      if (!superAdminRoleId) {
        throw new Error('Super Admin role was not created.');
      }

      await tx.userRole.upsert({
        where: {
          userId_roleId: {
            userId: user.id,
            roleId: superAdminRoleId,
          },
        },
        update: {},
        create: {
          userId: user.id,
          roleId: superAdminRoleId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          entityType: 'Bootstrap',
          entityId: user.id,
          action: 'BOOTSTRAP_SEED_APPLIED',
          newValue: {
            organizationSlug: organization.slug,
            rolesProvisioned: Object.keys(roleMap).length,
          },
        },
      });
    },
    {
      maxWait: 15000,
      timeout: 60000,
    }
  );

  console.log(
    `Bootstrap organization ready; admin user: ${email}`
  );

  console.log(
    'Bootstrap password hash synchronized from backend .env. Keep .env private and rotate credentials before production.'
  );
}

main()
  .catch((error) => {
    console.error('Database seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
