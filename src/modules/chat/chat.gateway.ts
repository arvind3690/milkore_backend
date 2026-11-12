import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { APP_JWT_AUDIENCE, AppJwtPayload } from '../../common/auth/auth.types';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';

const userRoom = (userId: string) => `user:${userId}`;

/**
 * Socket.IO namespace `/chat`. Push-only: clients never write messages over the socket
 * (REST is the single write path). Auth: `auth: { token }` or `Authorization: Bearer` in the handshake.
 * Each user joins `user:<id>`; events go to user rooms, so a user's devices all stay in sync.
 */
@WebSocketGateway({ namespace: '/chat', cors: { origin: true, credentials: true } })
export class ChatGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ChatGateway.name);
  private readonly lastTyping = new Map<string, number>();

  /** With a namespace, Nest injects the Namespace (not the root Server). */
  @WebSocketServer() server: Namespace;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const authToken = (client.handshake.auth as { token?: string })?.token;
      const header = client.handshake.headers.authorization;
      const token = authToken ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
      if (!token) throw new Error('no token');
      const payload = await this.jwt.verifyAsync<AppJwtPayload>(token, {
        secret: this.config.get('JWT_SECRET'),
        audience: APP_JWT_AUDIENCE,
      });
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, status: true } });
      if (!user || user.status !== 'ACTIVE') throw new Error('inactive');
      client.data.userId = user.id;
      await client.join(userRoom(user.id));
      client.emit('ready', { userId: user.id });
    } catch {
      client.emit('auth_error', { message: 'Session expired' });
      client.disconnect(true);
    }
  }

  isOnline(userId: string): boolean {
    return (this.server?.adapter?.rooms?.get(userRoom(userId))?.size ?? 0) > 0;
  }

  emitToUsers(userIds: string[], event: string, payload: unknown): void {
    if (!this.server) return;
    for (const id of new Set(userIds)) this.server.to(userRoom(id)).emit(event, payload);
  }

  /** Typing indicator: participant-checked and throttled to one event per 2 s per user/conversation. */
  @SubscribeMessage('typing')
  async typing(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId?: string }): Promise<void> {
    const userId = client.data.userId as string | undefined;
    const conversationId = body?.conversationId;
    if (!userId || typeof conversationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(conversationId)) return;
    const key = `${userId}:${conversationId}`;
    if (Date.now() - (this.lastTyping.get(key) ?? 0) < 2000) return;
    this.lastTyping.set(key, Date.now());
    if (this.lastTyping.size > 10_000) this.lastTyping.clear();

    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return;
    const vendor = await this.prisma.vendorProfile.findUnique({ where: { id: conv.vendorId }, select: { userId: true } });
    const participants = [conv.customerId, vendor?.userId].filter(Boolean) as string[];
    if (!participants.includes(userId)) return;
    this.emitToUsers(participants.filter((p) => p !== userId), 'typing', { conversationId, userId });
  }
}
