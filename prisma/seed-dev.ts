/**
 * Development-only demo data: 15 approved vendors around DEV_SEED_LAT/LNG and 3 customers.
 * Refuses to run in production. Re-running is safe (fixed fake phone numbers are upserted).
 * Run: npm run seed:dev
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NAMES = [
  'Shree Krishna Dairy', 'Gopal Doodh Bhandar', 'Nandini Milk Centre', 'Yadav Dairy Farm',
  'Kamdhenu Dairy', 'Ganga Milk Point', 'Sharma Dairy', 'Amrit Doodh Wala', 'Gau Seva Dairy',
  'Pure Desi Dairy', 'Shyam Milk Supply', 'Annapurna Dairy', 'Village Fresh Milk', 'Radhe Dairy',
  'Balaji Doodh Kendra',
];

const HOURS = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
    d,
    { open: '05:30', close: '21:00', closed: false },
  ]),
);

function offset(lat: number, lng: number, i: number): { lat: number; lng: number } {
  // Deterministic spiral up to ~8 km from the centre.
  const angle = i * 2.399963; // golden angle
  const km = 0.6 + (i % 8) * 1.0;
  const dLat = (km / 111) * Math.cos(angle);
  const dLng = (km / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle);
  return { lat: lat + dLat, lng: lng + dLng };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('seed:dev must not run in production');
  const lat = Number(process.env.DEV_SEED_LAT ?? 28.6139);
  const lng = Number(process.env.DEV_SEED_LNG ?? 77.209);
  const pins = (process.env.PILOT_PINCODES ?? '110001').split(',').map((p) => p.trim());

  const categories = await prisma.productCategory.findMany();
  const units = await prisma.unit.findMany();
  if (!categories.length || !units.length) throw new Error('Run `npm run db:seed` first');
  const cat = (slug: string) => categories.find((c) => c.slug === slug)!.id;
  const unit = (code: string) => units.find((u) => u.code === code)!.id;

  for (let i = 0; i < NAMES.length; i++) {
    const phone = `+9199999${String(10000 + i).slice(-5)}`;
    const p = offset(lat, lng, i);
    const user = await prisma.user.upsert({
      where: { phone },
      update: {},
      create: { phone, name: `Demo Vendor ${i + 1}`, role: 'VENDOR' },
    });
    const vendor = await prisma.vendorProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        businessName: NAMES[i],
        ownerName: `Demo Vendor ${i + 1}`,
        description: 'Fresh milk every morning and evening. Demo data.',
        operatingHours: HOURS,
        approvalStatus: 'APPROVED',
        approvedAt: new Date(),
        onboardingStep: 6,
        isAvailable: i % 5 !== 4,
        contactPhone: phone,
      },
    });

    const pin = pins[i % pins.length];
    await prisma.$executeRaw`
      INSERT INTO vendor_locations (id, vendor_id, address_line, locality, city, district, state, pincode, location, updated_at)
      VALUES (gen_random_uuid(), ${vendor.id}::uuid, ${`Shop ${i + 1}, Main Market`}, 'Connaught Place', 'New Delhi',
              'Central Delhi', 'Delhi', ${pin}, ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography, now())
      ON CONFLICT (vendor_id) DO NOTHING`;

    const areaCount = await prisma.vendorServiceArea.count({ where: { vendorId: vendor.id } });
    if (!areaCount) {
      await prisma.vendorServiceArea.createMany({
        data: [
          { vendorId: vendor.id, type: 'RADIUS', radiusMeters: 2000 + (i % 4) * 1000 },
          { vendorId: vendor.id, type: 'PINCODE', pincode: pin },
        ],
      });
    }

    const productCount = await prisma.vendorProduct.count({ where: { vendorId: vendor.id } });
    if (!productCount) {
      await prisma.vendorProduct.createMany({
        data: [
          { vendorId: vendor.id, categoryId: cat('cow-milk'), unitId: unit('LITRE'), name: 'Cow Milk', pricePaise: 5800 + i * 100 },
          { vendorId: vendor.id, categoryId: cat('buffalo-milk'), unitId: unit('LITRE'), name: 'Buffalo Milk', pricePaise: 6800 + i * 100 },
          { vendorId: vendor.id, categoryId: cat('curd'), unitId: unit('KG'), name: 'Fresh Curd', pricePaise: 8000 + i * 50 },
          ...(i % 2 === 0
            ? [{ vendorId: vendor.id, categoryId: cat('paneer'), unitId: unit('G_250'), name: 'Paneer', pricePaise: 9000 }]
            : []),
          ...(i % 3 === 0
            ? [{ vendorId: vendor.id, categoryId: cat('ghee'), unitId: unit('KG'), name: 'Desi Ghee', pricePaise: 65000, isAvailable: false }]
            : []),
        ],
      });
    }
  }

  for (let i = 0; i < 3; i++) {
    const phone = `+9199998${String(10000 + i).slice(-5)}`;
    await prisma.user.upsert({
      where: { phone },
      update: {},
      create: { phone, name: `Demo Customer ${i + 1}`, role: 'CUSTOMER', customerProfile: { create: {} } },
    });
  }

  const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM vendor_locations
    WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, 5000)`;
  console.log(`dev seed done: ${NAMES.length} vendors, 3 customers; vendors within 5 km of centre: ${n}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
