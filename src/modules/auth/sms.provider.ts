import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { maskPhone } from '../../common/utils/mask';

export abstract class SmsProvider {
  abstract sendOtp(phone: string, otp: string): Promise<void>;
}

/** Development provider: logs that an OTP was sent; prints the code only in development. */
@Injectable()
export class ConsoleSmsProvider extends SmsProvider {
  private readonly logger = new Logger('SMS');

  constructor(private readonly config: AppConfig) {
    super();
  }

  async sendOtp(phone: string, otp: string): Promise<void> {
    const code = this.config.isDevelopment ? ` code=${otp}` : '';
    this.logger.warn(`[console-sms] OTP sent to ${maskPhone(phone)}${code}`);
  }
}

/**
 * MSG91 OTP via the Flow API (DLT template). Needs MSG91_AUTH_KEY + MSG91_TEMPLATE_ID.
 * The template must contain a variable named `otp`.
 */
@Injectable()
export class Msg91SmsProvider extends SmsProvider {
  private readonly logger = new Logger('SMS');

  constructor(private readonly config: AppConfig) {
    super();
  }

  async sendOtp(phone: string, otp: string): Promise<void> {
    const authKey = this.config.get('MSG91_AUTH_KEY');
    const templateId = this.config.get('MSG91_TEMPLATE_ID');
    if (!authKey || !templateId) throw new Error('MSG91 is not configured');

    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: authKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        template_id: templateId,
        short_url: '0',
        recipients: [{ mobiles: phone.replace('+', ''), otp }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      this.logger.error(`MSG91 send failed (${res.status}) for ${maskPhone(phone)}`);
      throw new Error('SMS could not be sent');
    }
  }
}
