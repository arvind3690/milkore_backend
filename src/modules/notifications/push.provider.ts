import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { App, cert, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { getMessaging, Message, Messaging } from 'firebase-admin/messaging';
import { AppConfig } from '../../config/app-config.service';

/** Android notification channels; the app creates the same ids. */
export type PushChannel = 'chat' | 'account' | 'announcements';

/** One message to one device. `data` values must be strings (FCM rule). */
export interface PushEnvelope {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
  channel: PushChannel;
  /** Groups/replaces related notifications (e.g. one per chat). */
  collapseKey?: string;
}

export interface PushResult {
  delivered: number;
  failed: number;
  /** Tokens FCM says are dead; the caller deletes them. */
  invalidTokens: string[];
}

export abstract class PushProvider {
  abstract send(messages: PushEnvelope[]): Promise<PushResult>;
}

/** FCM error codes that mean "this token will never work again". */
const DEAD_TOKEN_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

export function isDeadTokenError(code: string | undefined): boolean {
  return !!code && DEAD_TOKEN_CODES.has(code);
}

/** Builds the FCM HTTP v1 message: visible notification + data for routing, per-platform options. */
export function toFcmMessage(m: PushEnvelope): Message {
  return {
    token: m.token,
    notification: { title: m.title, body: m.body },
    data: m.data,
    android: {
      priority: 'high',
      collapseKey: m.collapseKey,
      notification: {
        channelId: m.channel,
        tag: m.collapseKey,
        icon: 'ic_stat_notification',
        color: '#1769E0',
        defaultSound: true,
      },
    },
    apns: {
      headers: { 'apns-priority': '10', ...(m.collapseKey ? { 'apns-collapse-id': m.collapseKey.slice(0, 64) } : {}) },
      payload: { aps: { sound: 'default', threadId: m.collapseKey ?? m.channel } },
    },
  };
}

const FCM_BATCH = 500; // FCM sendEach limit

/** Sends through Firebase Cloud Messaging (HTTP v1) with the service-account key. */
@Injectable()
export class FcmPushProvider extends PushProvider {
  private readonly logger = new Logger('Push');
  private messaging?: Messaging;

  constructor(private readonly config: AppConfig) {
    super();
  }

  private client(): Messaging {
    if (this.messaging) return this.messaging;
    const b64 = this.config.get('FIREBASE_SERVICE_ACCOUNT_BASE64');
    const raw = b64
      ? Buffer.from(b64, 'base64').toString('utf8')
      : readFileSync(resolve(this.config.get('FIREBASE_SERVICE_ACCOUNT_PATH')), 'utf8');
    const app: App = initializeApp({ credential: cert(JSON.parse(raw) as ServiceAccount) }, 'milkore-push');
    this.messaging = getMessaging(app);
    return this.messaging;
  }

  async send(messages: PushEnvelope[]): Promise<PushResult> {
    const result: PushResult = { delivered: 0, failed: 0, invalidTokens: [] };
    if (messages.length === 0) return result;
    const messaging = this.client();
    for (let i = 0; i < messages.length; i += FCM_BATCH) {
      const chunk = messages.slice(i, i + FCM_BATCH);
      const res = await messaging.sendEach(chunk.map(toFcmMessage));
      result.delivered += res.successCount;
      result.failed += res.failureCount;
      res.responses.forEach((r, idx) => {
        if (r.success) return;
        if (isDeadTokenError(r.error?.code)) result.invalidTokens.push(chunk[idx]!.token);
        else this.logger.warn(`FCM send failed: ${r.error?.code ?? 'unknown'}`);
      });
    }
    return result;
  }
}

/** Development/test provider: logs a summary (never tokens or message text). */
@Injectable()
export class ConsolePushProvider extends PushProvider {
  private readonly logger = new Logger('Push');

  async send(messages: PushEnvelope[]): Promise<PushResult> {
    if (messages.length) {
      const types = [...new Set(messages.map((m) => m.data.type))].join(',');
      this.logger.log(`[console-push] ${messages.length} message(s) type=${types}`);
    }
    return { delivered: messages.length, failed: 0, invalidTokens: [] };
  }
}
