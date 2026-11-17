import { audienceWhere, describeAudience, isBroadcast, isVendorOnly } from './audience';
import { renderTemplate } from './notification-templates';
import { allowsPush, pushData } from './notifications.service';
import { isDeadTokenError, toFcmMessage } from './push.provider';

describe('notification templates', () => {
  it('renders vendor status in the user language with the reason', () => {
    const en = renderTemplate('en', { type: 'VENDOR_STATUS', status: 'REJECTED', reason: 'Blurry shop photo' });
    expect(en.title).toBe('Your shop needs changes');
    expect(en.body).toContain('Blurry shop photo');
    const hi = renderTemplate('hi', { type: 'VENDOR_STATUS', status: 'APPROVED' });
    expect(hi.title).toContain('स्वीकृत');
  });

  it('falls back for unknown statuses and missing reasons', () => {
    expect(renderTemplate('en', { type: 'VENDOR_STATUS', status: 'WHATEVER' }).title).toBe('Your shop is under review');
    expect(renderTemplate('en', { type: 'VENDOR_STATUS', status: 'SUSPENDED' }).body).toContain('not given');
  });

  it('uses the sender as the chat title, with a fallback', () => {
    expect(renderTemplate('en', { type: 'CHAT_MESSAGE', senderName: 'Sharma Dairy', preview: 'Hi' })).toEqual({ title: 'Sharma Dairy', body: 'Hi' });
    expect(renderTemplate('hi', { type: 'CHAT_MESSAGE', senderName: null, preview: 'Hi' }).title).toBe('नया संदेश');
  });

  it('shows the admin reply on support updates, else the status', () => {
    expect(renderTemplate('en', { type: 'SUPPORT_UPDATE', subject: 'Login', status: 'CLOSED', note: 'Fixed now' }).body).toBe('Login: Fixed now');
    expect(renderTemplate('en', { type: 'SUPPORT_UPDATE', subject: 'Login', status: 'CLOSED' }).body).toBe('Login: resolved');
  });

  it('clips long text to the column sizes', () => {
    const r = renderTemplate('en', { type: 'CHAT_MESSAGE', senderName: 'x'.repeat(300), preview: 'y'.repeat(900) });
    expect(r.title.length).toBe(120);
    expect(r.body.length).toBe(500);
  });
});

describe('audience', () => {
  it('always limits to active, non-deleted users', () => {
    expect(audienceWhere({ type: 'ALL' })).toEqual({ status: 'ACTIVE', deletedAt: null });
    expect(audienceWhere({ type: 'ROLE', role: 'VENDOR' })).toMatchObject({ status: 'ACTIVE', role: 'VENDOR' });
  });

  it('LOCATION matches customer PIN, vendor shop PIN and served PINs', () => {
    const w = audienceWhere({ type: 'LOCATION', pincode: '110001', role: 'VENDOR' });
    expect(w.role).toBe('VENDOR');
    expect(w.OR).toHaveLength(3);
    const both = audienceWhere({ type: 'LOCATION', pincode: '110001', city: 'Delhi' });
    expect(both.OR).toHaveLength(5);
  });

  it('VENDOR_STATUS targets vendors with that approval status', () => {
    expect(audienceWhere({ type: 'VENDOR_STATUS', approvalStatus: 'PENDING' })).toMatchObject({
      role: 'VENDOR',
      vendorProfile: { approvalStatus: 'PENDING', deletedAt: null },
    });
  });

  it('classifies broadcasts and vendor-only audiences', () => {
    expect(isBroadcast({ type: 'ALL' })).toBe(true);
    expect(isBroadcast({ type: 'USERS', userIds: ['a'] })).toBe(false);
    expect(isVendorOnly({ type: 'ROLE', role: 'VENDOR' })).toBe(true);
    expect(isVendorOnly({ type: 'LOCATION', pincode: '110001' })).toBe(false);
    expect(isVendorOnly({ type: 'VENDOR_STATUS', approvalStatus: 'APPROVED' })).toBe(true);
  });

  it('describes audiences for humans', () => {
    expect(describeAudience({ type: 'LOCATION', role: 'CUSTOMER', city: 'Delhi', pincode: '110001' })).toBe('Customers in Delhi / 110001');
    expect(describeAudience({ type: 'USERS', userIds: ['a', 'b'] })).toBe('2 selected user(s)');
  });
});

describe('push payload', () => {
  it('data has only strings and the routing keys', () => {
    const d = pushData({ notificationId: 'n1', type: 'VENDOR_STATUS', category: 'ACCOUNT', target: 'CHAT', targetParams: { conversationId: 'c1' } });
    expect(d).toEqual({ conversationId: 'c1', notificationId: 'n1', type: 'VENDOR_STATUS', category: 'ACCOUNT', target: 'CHAT' });
    expect(Object.values(d).every((v) => typeof v === 'string')).toBe(true);
  });

  it('routing keys cannot be overridden by target params', () => {
    const d = pushData({ type: 'CAMPAIGN', category: 'ANNOUNCEMENT', target: 'HOME', targetParams: { target: 'CHAT', type: 'x' } });
    expect(d.target).toBe('HOME');
    expect(d.type).toBe('CAMPAIGN');
  });

  it('respects preferences per category (no row = all on)', () => {
    expect(allowsPush(null, 'CHAT')).toBe(true);
    expect(allowsPush({ chat: false, account: true, announcements: true }, 'CHAT')).toBe(false);
    expect(allowsPush({ chat: true, account: true, announcements: false }, 'ANNOUNCEMENT')).toBe(false);
    expect(allowsPush({ chat: false, account: true, announcements: false }, 'ACCOUNT')).toBe(true);
  });

  it('builds an FCM message with channel, collapse and APNs thread', () => {
    const m = toFcmMessage({ token: 't', title: 'T', body: 'B', data: { a: '1' }, channel: 'chat', collapseKey: 'chat_1' }) as {
      android: { notification: { channelId: string; tag: string } };
      apns: { payload: { aps: { threadId: string } } };
    };
    expect(m.android.notification).toMatchObject({ channelId: 'chat', tag: 'chat_1' });
    expect(m.apns.payload.aps.threadId).toBe('chat_1');
  });

  it('only prunes tokens FCM says are dead', () => {
    expect(isDeadTokenError('messaging/registration-token-not-registered')).toBe(true);
    expect(isDeadTokenError('messaging/invalid-registration-token')).toBe(true);
    expect(isDeadTokenError('messaging/internal-error')).toBe(false);
    expect(isDeadTokenError(undefined)).toBe(false);
  });
});
