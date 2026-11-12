import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { verifyTotp } from '../../modules/admin/admin-auth.service';
import { cleanBody } from '../../modules/chat/chat.service';
import { parseIndiaPostResponse } from '../../modules/locations/providers';
import { validateHours } from '../../modules/vendors/vendors.service';
import { formatRupees, maskPhone, roundCoord } from './mask';
import { normalizeIndianMobile } from './phone';

describe('normalizeIndianMobile', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
  ])('%s → %s', (input, out) => expect(normalizeIndianMobile(input)).toBe(out));

  it.each(['12345', '5876543210', '98765432101', '', null])('rejects %p', (input) => {
    expect(normalizeIndianMobile(input as string)).toBeNull();
  });
});

describe('mask / format helpers', () => {
  it('masks phone numbers', () => expect(maskPhone('+919876543210')).toBe('+91******3210'));
  it('formats paise', () => {
    expect(formatRupees(6000)).toBe('₹60');
    expect(formatRupees(6050)).toBe('₹60.50');
    expect(formatRupees(12000000)).toBe('₹1,20,000');
  });
  it('rounds coordinates for logs', () => expect(roundCoord(28.63157)).toBe(28.63));
});

describe('parseIndiaPostResponse', () => {
  it('parses a PIN response (array with one object)', () => {
    const body = [
      {
        Message: 'Number of Post office(s) found: 1',
        Status: 'Success',
        PostOffice: [
          { Name: 'Baroda House', Description: '', BranchType: 'Sub Post Office', DeliveryStatus: 'Non-Delivery', Circle: 'New Delhi', District: 'Central Delhi', Division: 'New Delhi Central', Region: 'Delhi', State: 'Delhi', Country: 'India' },
        ],
      },
    ];
    expect(parseIndiaPostResponse(body, '110001')).toEqual([
      expect.objectContaining({ name: 'Baroda House', pincode: '110001', district: 'Central Delhi', state: 'Delhi', branchType: 'Sub Post Office' }),
    ]);
  });

  it('uses PINCode from branch-name responses', () => {
    const body = [{ Status: 'Success', PostOffice: [{ Name: 'NEW DELHI G.P.O.', PINCode: '110001', District: 'New Delhi', State: 'Delhi' }] }];
    expect(parseIndiaPostResponse(body)[0]).toMatchObject({ name: 'New Delhi G.P.O.', pincode: '110001' });
  });

  it('treats Status Error / PostOffice null as not found', () => {
    expect(parseIndiaPostResponse([{ Message: 'No records found', Status: 'Error', PostOffice: null }])).toEqual([]);
  });

  it('throws on a malformed body', () => expect(() => parseIndiaPostResponse('oops')).toThrow());
});

describe('validateHours', () => {
  const week = (over: Record<string, unknown> = {}) => ({
    ...Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '06:00', close: '20:00', closed: false }])),
    ...over,
  });
  it('accepts a full week', () => expect(validateHours(week()).mon).toEqual({ open: '06:00', close: '20:00', closed: false }));
  it('accepts a closed day without times', () => expect(validateHours(week({ sun: { closed: true } })).sun.closed).toBe(true));
  it('rejects bad times and missing days', () => {
    expect(() => validateHours(week({ mon: { open: '25:00', close: '20:00', closed: false } }))).toThrow(BadRequestException);
    expect(() => validateHours({ mon: { open: '06:00', close: '20:00', closed: false } })).toThrow(BadRequestException);
  });
});

describe('cleanBody', () => {
  it('trims and strips control characters', () => expect(cleanBody('  hi\u0007 there \n\n\n\nok ')).toBe('hi there \n\nok'));
  it('rejects empty and oversized messages', () => {
    expect(() => cleanBody('   ')).toThrow(BadRequestException);
    expect(() => cleanBody('a'.repeat(2001))).toThrow(BadRequestException);
  });
});

describe('verifyTotp', () => {
  // RFC 6238 test secret "12345678901234567890" in base32.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('accepts the current code and rejects a wrong one', () => {
    const now = 1_700_000_000_000;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
    const h = createHmac('sha1', Buffer.from('12345678901234567890')).update(counter).digest();
    const o = h[h.length - 1]! & 0xf;
    const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, code === '000000' ? '111111' : '000000', now)).toBe(false);
  });
});

describe('AllExceptionsFilter.toBody', () => {
  it('keeps field errors from validation', () => {
    const body = AllExceptionsFilter.toBody(new BadRequestException({ message: 'Check fields', errors: { phone: ['bad'] } }));
    expect(body).toEqual({ statusCode: 400, message: 'Check fields', data: null, errors: { phone: ['bad'] } });
  });
  it('maps 404s', () => expect(AllExceptionsFilter.toBody(new NotFoundException('Nope')).statusCode).toBe(404));
  it('hides internals of unknown errors', () => {
    expect(AllExceptionsFilter.toBody(new Error('SELECT * FROM secrets'))).toEqual({
      statusCode: 500,
      message: 'Something went wrong. Please try again.',
      data: null,
    });
  });
  it('rewrites the throttler message', () => {
    expect(AllExceptionsFilter.toBody(new HttpException('ThrottlerException: Too Many Requests', 429)).message).toMatch(/Too many requests/);
  });
});
