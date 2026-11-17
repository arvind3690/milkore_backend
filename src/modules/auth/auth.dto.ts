import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class OtpRequestDto {
  @ApiProperty({ example: '9876543210', description: 'Indian mobile, with or without +91' })
  @IsString()
  @MaxLength(20)
  phone: string;

  @ApiPropertyOptional({ enum: ['LOGIN'] })
  @IsOptional()
  @IsIn(['LOGIN'])
  purpose?: 'LOGIN';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;
}

export class OtpVerifyDto {
  @ApiProperty({ example: '9876543210' })
  @IsString()
  @MaxLength(20)
  phone: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6, { message: 'OTP must be 6 digits' })
  @Matches(/^\d{6}$/, { message: 'OTP must be 6 digits' })
  otp: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Refresh token (snake_case, as the app sends it)' })
  @IsString()
  @MaxLength(200)
  refresh_token: string;
}

export class LogoutDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refresh_token?: string;

  @ApiPropertyOptional({ description: "This device's FCM token; it stops receiving pushes for this account" })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  pushToken?: string;
}

export class UpdateMeDto {
  @ApiPropertyOptional({ example: 'Ramesh Kumar' })
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional({ enum: ['en', 'hi'] })
  @IsOptional()
  @IsIn(['en', 'hi'])
  preferredLanguage?: 'en' | 'hi';
}
