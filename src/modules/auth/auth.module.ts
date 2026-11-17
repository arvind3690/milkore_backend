import { Body, Controller, Delete, Get, HttpCode, Module, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthUser, clientIp, CurrentUser } from '../../common/auth/auth.types';
import { Public, ResponseMessage } from '../../common/decorators';
import { AppConfig } from '../../config/app-config.service';
import { LogoutDto, OtpRequestDto, OtpVerifyDto, RefreshDto, UpdateMeDto } from './auth.dto';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { ConsoleSmsProvider, Msg91SmsProvider, SmsProvider } from './sms.provider';
import { TokenService } from './token.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Under /auth/login so the app never treats a failure here as a session end. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login/otp/request')
  @HttpCode(200)
  @ResponseMessage('OTP sent')
  requestOtp(@Body() dto: OtpRequestDto, @Req() req: Request) {
    return this.auth.requestOtp(dto.phone, clientIp(req), dto.deviceId);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login/otp/verify')
  @HttpCode(200)
  @ResponseMessage('Logged in')
  verifyOtp(@Body() dto: OtpVerifyDto, @Req() req: Request) {
    return this.auth.verifyOtp(dto.phone, dto.otp, clientIp(req), dto.deviceId, req.headers['user-agent']);
  }

  /** Must answer HTTP 200 (the app's TokenRefresher rejects anything else). */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @ResponseMessage('Token refreshed')
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refresh_token, req.headers['user-agent']);
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(200)
  @ResponseMessage('Logged out')
  logout(@CurrentUser() user: AuthUser, @Body() dto: LogoutDto, @Req() req: Request) {
    return this.auth.logout(user.id, dto.refresh_token, clientIp(req), dto.pushToken);
  }
}

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Patch()
  @ResponseMessage('Profile updated')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.auth.updateMe(user.id, dto);
  }

  @Delete()
  @ResponseMessage('Your account has been deleted')
  remove(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.auth.deleteMe(user.id, clientIp(req));
  }
}

@Module({
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    OtpService,
    TokenService,
    {
      provide: SmsProvider,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        config.get('SMS_PROVIDER') === 'msg91' ? new Msg91SmsProvider(config) : new ConsoleSmsProvider(config),
    },
  ],
  exports: [TokenService, AuthService],
})
export class AuthModule {}
