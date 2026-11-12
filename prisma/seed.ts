/**
 * Idempotent base seed (safe in every environment): categories, units, first admin.
 * Run: npm run db:seed
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

export const CATEGORIES = [
  { slug: 'cow-milk', nameEn: 'Cow Milk', nameHi: 'गाय का दूध', iconKey: 'cow', sortOrder: 1 },
  { slug: 'buffalo-milk', nameEn: 'Buffalo Milk', nameHi: 'भैंस का दूध', iconKey: 'buffalo', sortOrder: 2 },
  { slug: 'mixed-milk', nameEn: 'Mixed Milk', nameHi: 'मिक्स दूध', iconKey: 'milk', sortOrder: 3 },
  { slug: 'toned-milk', nameEn: 'Toned Milk', nameHi: 'टोंड दूध', iconKey: 'milk_packet', sortOrder: 4 },
  { slug: 'curd', nameEn: 'Curd', nameHi: 'दही', iconKey: 'curd', sortOrder: 5 },
  { slug: 'paneer', nameEn: 'Paneer', nameHi: 'पनीर', iconKey: 'paneer', sortOrder: 6 },
  { slug: 'ghee', nameEn: 'Ghee', nameHi: 'घी', iconKey: 'ghee', sortOrder: 7 },
  { slug: 'other', nameEn: 'Other Dairy', nameHi: 'अन्य डेयरी', iconKey: 'other', sortOrder: 99 },
];

export const UNITS = [
  { code: 'LITRE', labelEn: 'litre', labelHi: 'लीटर', sortOrder: 1 },
  { code: 'ML_500', labelEn: '500 ml', labelHi: '500 मि.ली.', sortOrder: 2 },
  { code: 'KG', labelEn: 'kg', labelHi: 'किलो', sortOrder: 3 },
  { code: 'G_500', labelEn: '500 g', labelHi: '500 ग्राम', sortOrder: 4 },
  { code: 'G_250', labelEn: '250 g', labelHi: '250 ग्राम', sortOrder: 5 },
  { code: 'PIECE', labelEn: 'piece', labelHi: 'पीस', sortOrder: 6 },
];

async function main(): Promise<void> {
  for (const c of CATEGORIES) {
    await prisma.productCategory.upsert({ where: { slug: c.slug }, update: c, create: c });
  }
  for (const u of UNITS) {
    await prisma.unit.upsert({ where: { code: u.code }, update: u, create: u });
  }
  console.log(`categories: ${CATEGORIES.length}, units: ${UNITS.length}`);

  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (!existing) {
      await prisma.adminUser.create({
        data: {
          email,
          name: 'Milkore Admin',
          role: 'SUPER_ADMIN',
          passwordHash: await bcrypt.hash(password, 12),
        },
      });
      console.log(`super admin created: ${email}`);
    } else {
      console.log(`super admin exists: ${email} (password unchanged)`);
    }
  } else {
    console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set: no admin created');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
