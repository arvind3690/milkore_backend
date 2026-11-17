import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser } from '../../common/auth/auth.types';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { ResponseMessage } from '../../common/decorators';
import { MediaModule } from '../media/media.module';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommunicationPolicyService } from './communication-policy.service';

class StartConversationDto {
  @ApiProperty() @IsUUID() vendorId: string;
}

class SendMessageDto {
  @ApiProperty({ description: 'Client-generated id (UUID recommended); makes retries safe' })
  @IsString()
  @Length(8, 64)
  clientMessageId: string;

  @ApiProperty({ example: 'Do you deliver at 6 am?' }) @IsString() @Length(1, 2000) body: string;
}

class MessagesQuery {
  @ApiPropertyOptional({ description: 'Message id: load messages older than this' }) @IsOptional() @IsUUID() before?: string;
  @ApiPropertyOptional({ default: 30 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 30;
}

class CallDto {
  @ApiProperty() @IsUUID() vendorId: string;
}

@ApiTags('chat')
@ApiBearerAuth()
@Controller()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('conversations')
  @HttpCode(200)
  @ResponseMessage('Chat ready')
  start(@CurrentUser() user: AuthUser, @Body() dto: StartConversationDto) {
    return this.chat.start(user.id, dto.vendorId);
  }

  @Get('conversations')
  list(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.chat.list(user.id, q.page, q.limit);
  }

  @Get('conversations/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.get(user.id, id);
  }

  @Get('conversations/:id/messages')
  messages(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: MessagesQuery) {
    return this.chat.messages(user.id, id, q.before, q.limit);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('conversations/:id/messages')
  @ResponseMessage('Sent')
  send(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) {
    return this.chat.send(user.id, id, dto.clientMessageId, dto.body);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.markRead(user.id, id);
  }

  @Post('conversations/:id/block')
  @HttpCode(200)
  @ResponseMessage('Chat blocked')
  block(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.setBlocked(user.id, id, true);
  }

  @Post('conversations/:id/unblock')
  @HttpCode(200)
  @ResponseMessage('Chat unblocked')
  unblock(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.setBlocked(user.id, id, false);
  }

  @Get('me/unread-summary')
  unread(@CurrentUser() user: AuthUser) {
    return this.chat.unreadSummary(user.id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('calls')
  @HttpCode(200)
  call(@CurrentUser() user: AuthUser, @Body() dto: CallDto) {
    return this.chat.call(user.id, dto.vendorId);
  }
}

@Module({
  imports: [MediaModule, NotificationsModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, CommunicationPolicyService],
  // Re-exports NotificationsModule so importers (AdminModule) keep getting NotificationSender.
  exports: [ChatService, ChatGateway, NotificationsModule],
})
export class ChatModule {}
