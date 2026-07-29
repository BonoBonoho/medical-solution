import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  health(): unknown {
    return { status: 'ok' };
  }
}
