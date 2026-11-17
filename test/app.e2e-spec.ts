/**
 * End-to-end: the whole MVP flow over real HTTP + Socket.IO against the isolated test DB.
 * External services (SMS, India Post, Nominatim) are replaced by in-memory fakes.
 */
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { SmsProvider } from '../src/modules/auth/sms.provider';
import { GeocodingProvider, PincodeProvider } from '../src/modules/locations/providers';
import { CampaignsService } from '../src/modules/notifications/campaigns.service';
import { PushEnvelope, PushProvider, PushResult } from '../src/modules/notifications/push.provider';

const otps = new Map<string, string>();
const sms: SmsProvider = { sendOtp: async (phone, otp) => void otps.set(phone, otp) };
const pincodes: PincodeProvider = {
  byPincode: async (pin) =>
    pin === '110001'
      ? [{ name: 'Baroda House', pincode: '110001', branchType: 'Sub Post Office', deliveryStatus: 'Non-Delivery', circle: 'Delhi', district: 'Central Delhi', division: null, region: 'Delhi', state: 'Delhi', country: 'India' }]
      : [],
  byBranchName: async () => [],
};
/** Records every push; tokens starting with "dead" are reported invalid, like FCM does. */
const pushed: PushEnvelope[] = [];
const push: PushProvider = {
  send: async (messages: PushEnvelope[]): Promise<PushResult> => {
    pushed.push(...messages);
    const dead = messages.filter((m) => m.token.startsWith('dead')).map((m) => m.token);
    return { delivered: messages.length - dead.length, failed: dead.length, invalidTokens: dead };
  },
};
const geocoder: GeocodingProvider = {
  reverse: async () => ({ pincode: '110001', locality: 'Connaught Place', city: 'New Delhi', district: 'Central Delhi', state: 'Delhi' }),
};

// A unique phone per run so tests never collide with older data.
const run = String(Date.now()).slice(-6);
// One client IP per run, so OTP per-IP limits from earlier runs in the same hour don't leak in.
const RUN_IP = `10.${Number(run.slice(0, 2))}.${Number(run.slice(2, 4))}.${Number(run.slice(4, 6))}`;
const phone = (n: number) => `9${run}${String(n).padStart(3, '0')}`;
const SHOP = { lat: 28.6315, lng: 77.2167 };
const NEAR = { lat: 28.6400, lng: 77.2200 }; // ~1 km away
const FAR = { lat: 28.7500, lng: 77.1000 }; // ~17 km away

describe('Milkore API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let baseUrl: string;
  let prisma: PrismaService;

  const login = async (n: number) => {
    const p = phone(n);
    await http.post('/api/v1/auth/login/otp/request').set('X-Forwarded-For', RUN_IP).send({ phone: p }).expect(200);
    const res = await http.post('/api/v1/auth/login/otp/verify').send({ phone: p, otp: otps.get(`+91${p}`) }).expect(200);
    return res.body.data as { accessToken: string; refreshToken: string; user: { id: string; role: string } };
  };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SmsProvider).useValue(sms)
      .overrideProvider(PincodeProvider).useValue(pincodes)
      .overrideProvider(GeocodingProvider).useValue(geocoder)
      .overrideProvider(PushProvider).useValue(push)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    (app as NestExpressApplication).set('trust proxy', 1); // same as main.ts
    configureApp(app);
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // shared state across the ordered flow
  let customer: { accessToken: string; refreshToken: string; user: { id: string; role: string } };
  let vendorTok: string;
  let vendorId: string;
  let otherVendorTok: string;
  let adminTok: string;
  let productId: string;
  let conversationId: string;

  it('health uses the envelope', async () => {
    const res = await http.get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ statusCode: 200, message: 'Success', data: { db: 'up', postgis: 'installed' } });
  });

  it('unknown route → 404 envelope', async () => {
    const res = await http.get('/api/v1/nope').expect(404);
    expect(res.body).toEqual({ statusCode: 404, message: expect.any(String), data: null });
  });

  describe('auth', () => {
    it('rejects an invalid phone with field errors', async () => {
      const res = await http.post('/api/v1/auth/login/otp/request').send({ phone: '12345' }).expect(400);
      expect(res.body.errors.phone).toBeDefined();
    });

    it('wrong OTP is 400 (never 401) and counts attempts', async () => {
      await http.post('/api/v1/auth/login/otp/request').set('X-Forwarded-For', RUN_IP).send({ phone: phone(900) }).expect(200);
      const res = await http.post('/api/v1/auth/login/otp/verify').send({ phone: phone(900), otp: '000000' }).expect(400);
      expect(res.body.message).toMatch(/Wrong OTP/);
    });

    it('resend within 30 s is 429 with Retry-After', async () => {
      const res = await http.post('/api/v1/auth/login/otp/request').set('X-Forwarded-For', RUN_IP).send({ phone: phone(900) }).expect(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('logs in a new customer', async () => {
      customer = await login(1);
      expect(customer.user.role).toBe('CUSTOMER');
      expect(customer).toMatchObject({ isNewUser: true });
    });

    it('refresh returns HTTP 200, rotates, and detects reuse', async () => {
      const throwaway = await login(5);
      const r1 = await http.post('/api/v1/auth/refresh').send({ refresh_token: throwaway.refreshToken }).expect(200);
      expect(r1.body.data.accessToken).toBeDefined();
      await http.post('/api/v1/auth/refresh').send({ refresh_token: throwaway.refreshToken }).expect(401);
      // reuse revoked the family, so the newest token is dead too
      await http.post('/api/v1/auth/refresh').send({ refresh_token: r1.body.data.refreshToken }).expect(401);
    });

    it('protected routes need a token; PATCH /me works', async () => {
      await http.get('/api/v1/me').expect(401);
      const res = await http.patch('/api/v1/me').set(auth(customer.accessToken)).send({ name: 'Asha', preferredLanguage: 'hi' }).expect(200);
      expect(res.body.data).toMatchObject({ name: 'Asha', preferredLanguage: 'hi' });
    });
  });

  describe('locations', () => {
    it('searches by PIN and reverse-geocodes', async () => {
      const s = await http.get('/api/v1/locations/search?q=110001').expect(200);
      expect(s.body.data[0].label).toBe('Baroda House, Central Delhi, Delhi - 110001');
      const r = await http.get(`/api/v1/locations/reverse?lat=${SHOP.lat}&lng=${SHOP.lng}`).expect(200);
      expect(r.body.data.pincode).toBe('110001');
    });

    it('rejects coordinates outside India', async () => {
      await http.get('/api/v1/locations/reverse?lat=51.5&lng=-0.12').expect(400);
    });

    it('saves the customer location', async () => {
      const res = await http.put('/api/v1/customer/location').set(auth(customer.accessToken))
        .send({ ...NEAR, label: 'Near CP - 110001', pincode: '110001' }).expect(200);
      expect(res.body.data.lat).toBeCloseTo(NEAR.lat);
    });
  });

  describe('vendor onboarding', () => {
    let profilePhotoId: string;

    it('start upgrades the user to VENDOR', async () => {
      const t = await login(2);
      const res = await http.post('/api/v1/vendor/onboarding/start').set(auth(t.accessToken)).expect(200);
      vendorTok = res.body.data.accessToken;
      vendorId = res.body.data.vendor.id;
      expect(res.body.data.vendor.approvalStatus).toBe('DRAFT');
      expect(res.body.data.vendor.completion.percent).toBe(0);
    });

    it('a customer cannot use vendor endpoints', async () => {
      await http.get('/api/v1/vendor/products').set(auth(customer.accessToken)).expect(403);
    });

    it('uploads a photo (presigned local upload → confirm strips/resizes)', async () => {
      const jpeg = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#eeeeee' } }).jpeg().toBuffer();
      const up = await http.post('/api/v1/media/upload-url').set(auth(vendorTok))
        .send({ purpose: 'VENDOR_PROFILE', mimeType: 'image/jpeg', sizeBytes: jpeg.length }).expect(201);
      profilePhotoId = up.body.data.mediaId;
      await http.put(up.body.data.uploadUrl).set('Content-Type', 'image/jpeg').send(jpeg).expect(200);
      const c = await http.post(`/api/v1/media/${profilePhotoId}/confirm`).set(auth(vendorTok)).expect(201);
      expect(c.body.data).toMatchObject({ status: 'READY', width: 1280, height: 960 });
      await http.get(c.body.data.url).expect(200);
    });

    it('rejects a non-image upload', async () => {
      const up = await http.post('/api/v1/media/upload-url').set(auth(vendorTok))
        .send({ purpose: 'PRODUCT', mimeType: 'image/png', sizeBytes: 20 }).expect(201);
      await http.put(up.body.data.uploadUrl).set('Content-Type', 'image/png').send(Buffer.from('not really a png')).expect(200);
      await http.post(`/api/v1/media/${up.body.data.mediaId}/confirm`).set(auth(vendorTok)).expect(400);
    });

    it('submit before completing all steps lists what is missing', async () => {
      const res = await http.post('/api/v1/vendor/onboarding/submit').set(auth(vendorTok)).expect(400);
      expect(res.body.errors.missing).toEqual(expect.arrayContaining(['business', 'location']));
    });

    it('completes every step and submits', async () => {
      const hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '06:00', close: '20:00', closed: d === 'sun' }]));
      await http.patch('/api/v1/vendor/onboarding/business').set(auth(vendorTok))
        .send({ ownerName: 'Suresh', businessName: `E2E Dairy ${run}`, description: 'Fresh milk', operatingHours: hours }).expect(200);
      await http.patch('/api/v1/vendor/onboarding/photos').set(auth(vendorTok)).send({ profilePhotoId }).expect(200);
      await http.patch('/api/v1/vendor/onboarding/location').set(auth(vendorTok))
        .send({ addressLine: 'Shop 1, Main Market', locality: 'Connaught Place', city: 'New Delhi', district: 'Central Delhi', state: 'Delhi', pincode: '110001', ...SHOP }).expect(200);
      await http.put('/api/v1/vendor/onboarding/service-areas').set(auth(vendorTok)).send({ radiusMeters: 3000, pincodes: ['110002'] }).expect(200);
      const res = await http.post('/api/v1/vendor/onboarding/submit').set(auth(vendorTok)).expect(200);
      expect(res.body.data).toMatchObject({ approvalStatus: 'PENDING', completion: { percent: 100 } });
    });

    it('rejects bad operating hours with a field error', async () => {
      const res = await http.patch('/api/v1/vendor/profile').set(auth(vendorTok)).send({ operatingHours: { mon: { open: '25:00' } } }).expect(400);
      expect(res.body.errors.operatingHours).toBeDefined();
    });
  });

  describe('admin', () => {
    it('app tokens never work on admin routes', async () => {
      await http.get('/api/v1/admin/stats').set(auth(vendorTok)).expect(401);
    });

    it('admin logs in and approves the vendor', async () => {
      const res = await http.post('/api/v1/admin/auth/login')
        .send({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }).expect(200);
      adminTok = res.body.data.accessToken;
      const pending = await http.get('/api/v1/admin/vendors?status=PENDING').set(auth(adminTok)).expect(200);
      expect(pending.body.data.items.map((v: { id: string }) => v.id)).toContain(vendorId);
      await http.post(`/api/v1/admin/vendors/${vendorId}/reject`).set(auth(adminTok)).send({}).expect(400); // reason required
      const ok = await http.post(`/api/v1/admin/vendors/${vendorId}/approve`).set(auth(adminTok)).expect(200);
      expect(ok.body.data.approvalStatus).toBe('APPROVED');
    });

    it('wrong admin password is 401', async () => {
      await http.post('/api/v1/admin/auth/login').send({ email: process.env.SEED_ADMIN_EMAIL, password: 'definitely-wrong' }).expect(401);
    });

    it('moderators cannot manage categories', async () => {
      const email = `mod${run}@milkore.local`;
      await http.post('/api/v1/admin/admins').set(auth(adminTok)).send({ email, name: 'Mod', password: 'Moderator#12345', role: 'MODERATOR' }).expect(201);
      const mod = await http.post('/api/v1/admin/auth/login').send({ email, password: 'Moderator#12345' }).expect(200);
      await http.post('/api/v1/admin/categories').set(auth(mod.body.data.accessToken))
        .send({ slug: `x${run}`, nameEn: 'X', nameHi: 'X', iconKey: 'milk' }).expect(403);
      await http.get('/api/v1/admin/stats').set(auth(mod.body.data.accessToken)).expect(200);
    });
  });

  describe('products', () => {
    it('vendor adds a product priced in paise', async () => {
      const cats = await http.get('/api/v1/catalog/categories').expect(200);
      const units = await http.get('/api/v1/catalog/units').expect(200);
      const cow = cats.body.data.find((c: { slug: string }) => c.slug === 'cow-milk');
      const litre = units.body.data.find((u: { code: string }) => u.code === 'LITRE');
      const res = await http.post('/api/v1/vendor/products').set(auth(vendorTok))
        .send({ categoryId: cow.id, unitId: litre.id, name: 'Cow Milk', pricePaise: 6000 }).expect(201);
      productId = res.body.data.id;
      expect(res.body.data.priceDisplay).toBe('₹60 / litre');
    });

    it('price change is recorded', async () => {
      await http.patch(`/api/v1/vendor/products/${productId}/price`).set(auth(vendorTok)).send({ pricePaise: 6200 }).expect(200);
      expect(await prisma.priceHistory.count({ where: { vendorProductId: productId } })).toBe(1);
    });

    it('another vendor cannot touch it (404, not 403)', async () => {
      const t = await login(3);
      const started = await http.post('/api/v1/vendor/onboarding/start').set(auth(t.accessToken)).expect(200);
      otherVendorTok = started.body.data.accessToken;
      await http.patch(`/api/v1/vendor/products/${productId}`).set(auth(otherVendorTok)).send({ pricePaise: 100 }).expect(404);
      await http.delete(`/api/v1/vendor/products/${productId}`).set(auth(otherVendorTok)).expect(404);
    });
  });

  describe('discovery', () => {
    const ids = (body: { data: { items: { id: string }[] } }) => body.data.items.map((v) => v.id);

    it('finds the vendor inside its radius, with distance and prices', async () => {
      const res = await http.get(`/api/v1/discovery/vendors?lat=${NEAR.lat}&lng=${NEAR.lng}&limit=50`).expect(200);
      const v = res.body.data.items.find((x: { id: string }) => x.id === vendorId);
      expect(v).toBeDefined();
      expect(v.distanceMeters).toBeGreaterThan(500);
      expect(v.distanceMeters).toBeLessThan(2000);
      expect(v.products[0].priceDisplay).toBe('₹62 / litre');
      expect(v.profilePhotoUrl).toMatch(/^\/api\/v1\/media\/files\//);
    });

    it('does not find it outside the radius', async () => {
      const res = await http.get(`/api/v1/discovery/vendors?lat=${FAR.lat}&lng=${FAR.lng}&limit=50`).expect(200);
      expect(ids(res.body)).not.toContain(vendorId);
    });

    it('finds it by a served PIN even outside the radius', async () => {
      const res = await http.get(`/api/v1/discovery/vendors?lat=${FAR.lat}&lng=${FAR.lng}&pincode=110002&limit=50`).expect(200);
      expect(ids(res.body)).toContain(vendorId);
    });

    it('filters by search text', async () => {
      const res = await http.get(`/api/v1/discovery/vendors?lat=${NEAR.lat}&lng=${NEAR.lng}&q=E2E%20Dairy%20${run}`).expect(200);
      expect(ids(res.body)).toEqual([vendorId]);
    });

    it('unapproved vendors are hidden; details hide the phone', async () => {
      const draftVendorId = (await prisma.vendorProfile.findFirstOrThrow({ where: { user: { phone: `+91${phone(3)}` } } })).id;
      await http.get(`/api/v1/vendors/${draftVendorId}`).expect(404);
      const res = await http.get(`/api/v1/vendors/${vendorId}?lat=${NEAR.lat}&lng=${NEAR.lng}`).expect(200);
      expect(res.body.data.canCall).toBe(true);
      expect(JSON.stringify(res.body.data)).not.toContain(phone(2));
    });

    it('requires a location', async () => {
      await http.get('/api/v1/discovery/vendors').expect(400);
    });
  });

  describe('chat and calls', () => {
    let vendorSocket: Socket;

    afterAll(() => vendorSocket?.disconnect());

    it('vendor connects to the socket', async () => {
      vendorSocket = io(`${baseUrl}/chat`, { auth: { token: vendorTok }, transports: ['websocket'] });
      await new Promise<void>((resolve, reject) => {
        vendorSocket.on('ready', () => resolve());
        vendorSocket.on('connect_error', reject);
      });
    });

    it('customer starts a chat and sends a message the vendor receives live', async () => {
      const c = await http.post('/api/v1/conversations').set(auth(customer.accessToken)).send({ vendorId }).expect(200);
      conversationId = c.body.data.id;
      const received = new Promise<{ message: { body: string } }>((resolve) => vendorSocket.once('message:new', resolve));
      const clientMessageId = randomUUID();
      const sent = await http.post(`/api/v1/conversations/${conversationId}/messages`).set(auth(customer.accessToken))
        .send({ clientMessageId, body: 'Do you deliver at 6 am?' }).expect(201);
      expect((await received).message.body).toBe('Do you deliver at 6 am?');
      // retry with the same clientMessageId is idempotent
      const again = await http.post(`/api/v1/conversations/${conversationId}/messages`).set(auth(customer.accessToken))
        .send({ clientMessageId, body: 'Do you deliver at 6 am?' }).expect(201);
      expect(again.body.data.id).toBe(sent.body.data.id);
    });

    it('vendor sees 1 unread, reads it, and replies', async () => {
      const s = await http.get('/api/v1/me/unread-summary').set(auth(vendorTok)).expect(200);
      expect(s.body.data.unreadMessages).toBe(1);
      const list = await http.get('/api/v1/conversations').set(auth(vendorTok)).expect(200);
      expect(list.body.data.items[0]).toMatchObject({ id: conversationId, myRole: 'VENDOR', counterpart: { name: 'Asha' } });
      await http.post(`/api/v1/conversations/${conversationId}/read`).set(auth(vendorTok)).expect(200);
      await http.post(`/api/v1/conversations/${conversationId}/messages`).set(auth(vendorTok))
        .send({ clientMessageId: randomUUID(), body: 'Yes, 6 am daily.' }).expect(201);
      const msgs = await http.get(`/api/v1/conversations/${conversationId}/messages?limit=1`).set(auth(customer.accessToken)).expect(200);
      expect(msgs.body.data.items[0].body).toBe('Yes, 6 am daily.');
      expect(msgs.body.data.nextCursor).not.toBeNull();
    });

    it('outsiders cannot read the chat', async () => {
      await http.get(`/api/v1/conversations/${conversationId}/messages`).set(auth(otherVendorTok)).expect(404);
    });

    it('call reveals the phone to a logged-in customer and is logged', async () => {
      await http.post('/api/v1/calls').send({ vendorId }).expect(401);
      const res = await http.post('/api/v1/calls').set(auth(customer.accessToken)).send({ vendorId }).expect(200);
      expect(res.body.data.phone).toBe(`+91${phone(2)}`);
      expect(await prisma.communicationAccess.count({ where: { customerId: customer.user.id, vendorId } })).toBe(2);
    });
  });

  describe('trust, suspension, deletion', () => {
    it('customer reports the vendor and opens a ticket', async () => {
      await http.post('/api/v1/reports').set(auth(customer.accessToken)).send({ targetType: 'VENDOR', targetId: vendorId, reason: 'WRONG_PRICE' }).expect(201);
      await http.post('/api/v1/support/tickets').set(auth(customer.accessToken)).send({ subject: 'Help', message: 'How do I change my location?' }).expect(201);
      const reports = await http.get('/api/v1/admin/reports?status=OPEN').set(auth(adminTok)).expect(200);
      expect(reports.body.data.total).toBeGreaterThan(0);
    });

    it('a suspended vendor disappears from discovery', async () => {
      await http.post(`/api/v1/admin/vendors/${vendorId}/suspend`).set(auth(adminTok)).send({ reason: 'Fake listing' }).expect(200);
      const res = await http.get(`/api/v1/discovery/vendors?lat=${NEAR.lat}&lng=${NEAR.lng}&limit=50`).expect(200);
      expect(res.body.data.items.map((v: { id: string }) => v.id)).not.toContain(vendorId);
      await http.post(`/api/v1/admin/vendors/${vendorId}/reactivate`).set(auth(adminTok)).expect(200);
    });

    it('a suspended user gets 403', async () => {
      await http.patch(`/api/v1/admin/users/${customer.user.id}/status`).set(auth(adminTok)).send({ status: 'SUSPENDED', reason: 'abuse' }).expect(200);
      await http.get('/api/v1/me').set(auth(customer.accessToken)).expect(403);
      await http.patch(`/api/v1/admin/users/${customer.user.id}/status`).set(auth(adminTok)).send({ status: 'ACTIVE' }).expect(200);
    });

    it('account deletion anonymises and logs out', async () => {
      const t = await login(4);
      await http.delete('/api/v1/me').set(auth(t.accessToken)).expect(200);
      await http.get('/api/v1/me').set(auth(t.accessToken)).expect(401);
      await http.post('/api/v1/auth/refresh').send({ refresh_token: t.refreshToken }).expect(401);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: t.user.id } });
      expect(user.phone.startsWith('del_')).toBe(true);
    });

    it('audit log captured admin actions', async () => {
      const res = await http.get(`/api/v1/admin/audit-logs?entityId=${vendorId}`).set(auth(adminTok)).expect(200);
      const actions = res.body.data.items.map((a: { action: string }) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['vendor.approved', 'vendor.suspended']));
    });
  });

  describe('push notifications', () => {
    const custToken = `cust-token-${run}-aaaaaaaaaaaa`;
    const vendToken = `vend-token-${run}-aaaaaaaaaaaa`;
    let vendorUserId: string;
    const after = (mark: number, token: string) => pushed.slice(mark).filter((m) => m.token === token);

    beforeAll(async () => {
      vendorUserId = (await prisma.vendorProfile.findUniqueOrThrow({ where: { id: vendorId } })).userId;
    });

    it('registers devices (idempotent) and validates input', async () => {
      await http.post('/api/v1/me/devices').send({ token: custToken, platform: 'ANDROID' }).expect(401);
      const bad = await http.post('/api/v1/me/devices').set(auth(customer.accessToken)).send({ token: custToken, platform: 'WINDOWS' }).expect(400);
      expect(bad.body.errors.platform).toBeDefined();
      const dev = { token: custToken, platform: 'ANDROID', deviceId: `dev-c-${run}`, appVersion: '1.0.0+1' };
      await http.post('/api/v1/me/devices').set(auth(customer.accessToken)).send(dev).expect(200);
      await http.post('/api/v1/me/devices').set(auth(customer.accessToken)).send(dev).expect(200);
      await http.post('/api/v1/me/devices').set(auth(vendorTok)).send({ token: vendToken, platform: 'IOS', deviceId: `dev-v-${run}` }).expect(200);
      expect(await prisma.deviceToken.count({ where: { token: { in: [custToken, vendToken] } } })).toBe(2);
    });

    it('vendor status changes push to the vendor with a dashboard link and an inbox entry', async () => {
      const mark = pushed.length;
      await http.post(`/api/v1/admin/vendors/${vendorId}/suspend`).set(auth(adminTok)).send({ reason: 'Check documents' }).expect(200);
      await http.post(`/api/v1/admin/vendors/${vendorId}/reactivate`).set(auth(adminTok)).expect(200);
      const mine = after(mark, vendToken);
      expect(mine).toHaveLength(2);
      expect(mine[0]!.body).toContain('Check documents');
      expect(mine[1]).toMatchObject({ channel: 'account', title: 'Your shop is approved 🎉', data: { type: 'VENDOR_STATUS', category: 'ACCOUNT', target: 'VENDOR_DASHBOARD' } });
      expect(after(mark, custToken)).toHaveLength(0);
      const inbox = await http.get('/api/v1/me/notifications').set(auth(vendorTok)).expect(200);
      expect(inbox.body.data.items[0]).toMatchObject({ id: mine[1]!.data.notificationId, type: 'VENDOR_STATUS', isRead: false, target: 'VENDOR_DASHBOARD' });
      expect(inbox.body.data.unreadCount).toBeGreaterThanOrEqual(2);
    });

    it('marks one read, then all; unread counts follow', async () => {
      const inbox = await http.get('/api/v1/me/notifications?limit=1').set(auth(vendorTok)).expect(200);
      const id = inbox.body.data.items[0].id;
      const r = await http.post(`/api/v1/me/notifications/${id}/read`).set(auth(vendorTok)).expect(200);
      expect(r.body.data.isRead).toBe(true);
      await http.post(`/api/v1/me/notifications/${id}/read`).set(auth(customer.accessToken)).expect(404); // not theirs
      await http.post('/api/v1/me/notifications/read-all').set(auth(vendorTok)).expect(200);
      const s = await http.get('/api/v1/me/unread-summary').set(auth(vendorTok)).expect(200);
      expect(s.body.data.unreadNotifications).toBe(0);
      const c = await http.get('/api/v1/me/notifications/unread-count').set(auth(vendorTok)).expect(200);
      expect(c.body.data.unreadCount).toBe(0);
      const unreadOnly = await http.get('/api/v1/me/notifications?unreadOnly=true').set(auth(vendorTok)).expect(200);
      expect(unreadOnly.body.data.total).toBe(0);
    });

    it('chat to an offline vendor is pushed (not stored in the inbox) and respects preferences', async () => {
      const mark = pushed.length;
      await http.post(`/api/v1/conversations/${conversationId}/messages`).set(auth(customer.accessToken))
        .send({ clientMessageId: randomUUID(), body: 'Need 2 litres tomorrow' }).expect(201);
      const [chat] = after(mark, vendToken);
      expect(chat).toMatchObject({ title: 'Asha', body: 'Need 2 litres tomorrow', channel: 'chat', collapseKey: `chat_${conversationId}`, data: { target: 'CHAT', conversationId, type: 'CHAT_MESSAGE' } });
      expect(chat!.data.notificationId).toBeUndefined();

      const prefs = await http.patch('/api/v1/me/notification-preferences').set(auth(vendorTok)).send({ chat: false }).expect(200);
      expect(prefs.body.data).toEqual({ chat: false, account: true, announcements: true });
      await http.patch('/api/v1/me/notification-preferences').set(auth(vendorTok)).send({ chat: 'nope' }).expect(400);
      const mark2 = pushed.length;
      await http.post(`/api/v1/conversations/${conversationId}/messages`).set(auth(customer.accessToken))
        .send({ clientMessageId: randomUUID(), body: 'And curd too' }).expect(201);
      expect(after(mark2, vendToken)).toHaveLength(0);
      await http.patch('/api/v1/me/notification-preferences').set(auth(vendorTok)).send({ chat: true }).expect(200);
    });

    it('product moderation reaches the vendor; support replies reach the customer in Hindi', async () => {
      const mark = pushed.length;
      await http.post(`/api/v1/admin/products/${productId}/remove`).set(auth(adminTok)).send({ reason: 'Wrong photo' }).expect(200);
      await http.post(`/api/v1/admin/products/${productId}/restore`).set(auth(adminTok)).expect(200);
      const v = after(mark, vendToken);
      expect(v.map((m) => m.data.type)).toEqual(['PRODUCT_MODERATED', 'PRODUCT_MODERATED']);
      expect(v[0]!.data).toMatchObject({ target: 'VENDOR_PRODUCTS', productId });
      expect(v[0]!.body).toContain('Wrong photo');

      const ticket = await prisma.supportTicket.findFirstOrThrow({ where: { userId: customer.user.id } });
      const mark2 = pushed.length;
      const note = 'Open Profile, then Change location';
      await http.patch(`/api/v1/admin/support-tickets/${ticket.id}`).set(auth(adminTok)).send({ status: 'IN_PROGRESS', adminNote: note }).expect(200);
      await http.patch(`/api/v1/admin/support-tickets/${ticket.id}`).set(auth(adminTok)).send({ adminNote: note }).expect(200); // no visible change
      const c = after(mark2, custToken);
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({ title: 'आपके सहायता अनुरोध पर अपडेट', body: `Help: ${note}`, data: { type: 'SUPPORT_UPDATE', target: 'SUPPORT', ticketId: ticket.id } });
    });

    it('closing a report thanks the reporter once', async () => {
      const report = await prisma.report.findFirstOrThrow({ where: { reporterUserId: customer.user.id, status: 'OPEN' } });
      const mark = pushed.length;
      await http.patch(`/api/v1/admin/reports/${report.id}`).set(auth(adminTok)).send({ status: 'RESOLVED' }).expect(200);
      await http.patch(`/api/v1/admin/reports/${report.id}`).set(auth(adminTok)).send({ status: 'RESOLVED', note: 'Price fixed' }).expect(200);
      expect(after(mark, custToken).filter((m) => m.data.type === 'REPORT_RESOLVED')).toHaveLength(1);
    });

    describe('admin campaigns', () => {
      let modTok: string;
      const campaigns = '/api/v1/admin/notifications/campaigns';
      const drain = () => app.get(CampaignsService).drain();

      beforeAll(async () => {
        const mod = await http.post('/api/v1/admin/auth/login').send({ email: `mod${run}@milkore.local`, password: 'Moderator#12345' }).expect(200);
        modTok = mod.body.data.accessToken;
      });

      it('app tokens are refused; moderators cannot broadcast', async () => {
        await http.post(campaigns).set(auth(customer.accessToken)).send({}).expect(401);
        await http.post(campaigns).set(auth(modTok)).send({ titleEn: 'Hello all', bodyEn: 'Big news', audience: { type: 'ALL' } }).expect(403);
      });

      it('validates the audience and the target screen', async () => {
        const base = { titleEn: 'Hello', bodyEn: 'Body text' };
        const r1 = await http.post(campaigns).set(auth(adminTok)).send({ ...base, audience: { type: 'ROLE' } }).expect(400);
        expect(r1.body.errors['audience.role']).toBeDefined();
        const r2 = await http.post(campaigns).set(auth(adminTok)).send({ ...base, audience: { type: 'ROLE', role: 'CUSTOMER' }, target: 'VENDOR_PRODUCTS' }).expect(400);
        expect(r2.body.errors.target).toBeDefined();
        await http.post(campaigns).set(auth(adminTok)).send({ ...base, audience: { type: 'ROLE', role: 'CUSTOMER' }, target: 'CHAT' }).expect(400);
        await http.post(campaigns).set(auth(adminTok)).send({ ...base, audience: { type: 'LOCATION' } }).expect(400);
        await http.post(campaigns).set(auth(adminTok)).send({ ...base, audience: { type: 'USERS', userIds: [randomUUID()] } }).expect(400); // nobody matches
      });

      it('previews the audience by PIN code', async () => {
        const r = await http.post('/api/v1/admin/notifications/audience-preview').set(auth(modTok))
          .send({ audience: { type: 'LOCATION', pincode: '110001', role: 'CUSTOMER' } }).expect(200);
        expect(r.body.data.recipients).toBeGreaterThanOrEqual(1);
        expect(r.body.data.reachable).toBeGreaterThanOrEqual(1);
        expect(r.body.data.label).toBe('Customers in 110001');
      });

      it('sends to selected users in their language, with inbox entries and delivery counts', async () => {
        const mark = pushed.length;
        const res = await http.post(campaigns).set(auth(modTok)).send({
          titleEn: 'Fresh paneer Sunday', bodyEn: 'Order before 9 am.', titleHi: 'रविवार को ताज़ा पनीर', bodyHi: 'सुबह 9 बजे से पहले ऑर्डर करें।',
          audience: { type: 'USERS', userIds: [customer.user.id, vendorUserId] }, target: 'VENDOR_DETAILS', targetParams: { vendorId },
        }).expect(201);
        expect(res.body.data).toMatchObject({ status: 'SENDING', recipientCount: 2, audienceLabel: '2 selected user(s)' });
        await drain();
        const [toCustomer] = after(mark, custToken);
        expect(toCustomer).toMatchObject({ title: 'रविवार को ताज़ा पनीर', channel: 'announcements', data: { type: 'CAMPAIGN', target: 'VENDOR_DETAILS', vendorId, campaignId: res.body.data.id } });
        expect(after(mark, vendToken)[0]!.title).toBe('Fresh paneer Sunday');
        const inbox = await http.get('/api/v1/me/notifications?limit=1').set(auth(customer.accessToken)).expect(200);
        expect(inbox.body.data.items[0]).toMatchObject({ id: toCustomer!.data.notificationId, type: 'CAMPAIGN', targetParams: { vendorId } });
        await http.post(`/api/v1/me/notifications/${toCustomer!.data.notificationId}/read`).set(auth(customer.accessToken)).expect(200);
        const detail = await http.get(`${campaigns}/${res.body.data.id}`).set(auth(modTok)).expect(200);
        expect(detail.body.data).toMatchObject({ status: 'SENT', recipientCount: 2, deliveredCount: 2, failedCount: 0, noDeviceCount: 0, readCount: 1 });
        const list = await http.get(campaigns).set(auth(modTok)).expect(200);
        expect(list.body.data.items[0].id).toBe(res.body.data.id);
      });

      it('broadcast to vendors: opted-out users get only the inbox entry; dead tokens are pruned', async () => {
        await http.patch('/api/v1/me/notification-preferences').set(auth(vendorTok)).send({ announcements: false }).expect(200);
        const dead = `dead-token-${run}-aaaaaaaaaa`;
        await http.post('/api/v1/me/devices').set(auth(otherVendorTok)).send({ token: dead, platform: 'ANDROID' }).expect(200);
        const mark = pushed.length;
        const res = await http.post(campaigns).set(auth(adminTok))
          .send({ titleEn: 'Update your prices', bodyEn: 'Customers see fresh prices first.', audience: { type: 'ROLE', role: 'VENDOR' }, target: 'VENDOR_PRODUCTS' }).expect(201);
        await drain();
        expect(after(mark, vendToken)).toHaveLength(0);
        expect(after(mark, custToken)).toHaveLength(0); // customers are not in this audience
        expect(after(mark, dead)).toHaveLength(1);
        expect(await prisma.notification.count({ where: { campaignId: res.body.data.id, userId: vendorUserId } })).toBe(1);
        expect(await prisma.deviceToken.count({ where: { token: dead } })).toBe(0);
        const detail = await http.get(`${campaigns}/${res.body.data.id}`).set(auth(adminTok)).expect(200);
        expect(detail.body.data.status).toBe('SENT');
        expect(detail.body.data.failedCount).toBeGreaterThanOrEqual(1);
        expect(detail.body.data.noDeviceCount).toBeGreaterThanOrEqual(1);
        const audit = await http.get(`/api/v1/admin/audit-logs?entityId=${res.body.data.id}`).set(auth(adminTok)).expect(200);
        expect(audit.body.data.items[0].action).toBe('notification.campaign');
        await http.patch('/api/v1/me/notification-preferences').set(auth(vendorTok)).send({ announcements: true }).expect(200);
      });
    });

    it('a token moves to whoever logs in on that device', async () => {
      const shared = `shared-token-${run}-aaaaaaaa`;
      await http.post('/api/v1/me/devices').set(auth(customer.accessToken)).send({ token: shared, platform: 'ANDROID' }).expect(200);
      await http.post('/api/v1/me/devices').set(auth(vendorTok)).send({ token: shared, platform: 'ANDROID' }).expect(200);
      const row = await prisma.deviceToken.findUniqueOrThrow({ where: { token: shared } });
      expect(row.userId).toBe(vendorUserId);
    });

    it('logout with the push token, and unregister, stop pushes to that device', async () => {
      const t = await login(6);
      const tok = `logout-token-${run}-aaaaaaaa`;
      await http.post('/api/v1/me/devices').set(auth(t.accessToken)).send({ token: tok, platform: 'ANDROID' }).expect(200);
      await http.post('/api/v1/auth/logout').set(auth(t.accessToken)).send({ refresh_token: t.refreshToken, pushToken: tok }).expect(200);
      expect(await prisma.deviceToken.count({ where: { token: tok } })).toBe(0);
      await http.post('/api/v1/me/devices/unregister').set(auth(customer.accessToken)).send({ token: custToken }).expect(200);
      expect(await prisma.deviceToken.count({ where: { token: custToken } })).toBe(0);
    });
  });
});
