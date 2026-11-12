import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { HealthModule } from './health/health.module';
import { LocationsModule } from './locations/locations.module';
import { MediaModule } from './media/media.module';
import { TrustModule } from './trust/trust.module';
import { VendorsModule } from './vendors/vendors.module';

/** Every feature module, in dependency order. */
export const FEATURE_MODULES = [
  HealthModule,
  AuthModule,
  LocationsModule,
  MediaModule,
  VendorsModule,
  DiscoveryModule,
  ChatModule,
  TrustModule,
  AdminModule,
];
