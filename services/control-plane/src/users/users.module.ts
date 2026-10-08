import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { KeycloakModule } from '../keycloak/keycloak.module';
import { TenantsModule } from '../tenants/tenants.module';

import { KeycloakUsersService } from './keycloak-users.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    AuthModule,
    KeycloakModule,
    TenantsModule,
  ],

  controllers: [
    UsersController,
  ],

  providers: [
    UsersService,
    KeycloakUsersService,
  ],

  exports: [
    KeycloakUsersService,
  ],
})
export class UsersModule {}
