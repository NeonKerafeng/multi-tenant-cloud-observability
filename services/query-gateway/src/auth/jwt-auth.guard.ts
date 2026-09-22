import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  override canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      headers: {
        authorization?: string;
      };
      method?: string;
      url?: string;
    }>();

    const authorization = request.headers.authorization;
    const scheme = authorization?.split(' ', 1)[0] ?? null;

    console.log('[JwtAuthGuard]', {
      method: request.method,
      path: request.url,
      authorizationPresent: Boolean(authorization),
      scheme,
    });

    return super.canActivate(context);
  }
}
