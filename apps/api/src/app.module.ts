import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthMiddleware } from './common/auth.middleware.js';
import { MemoryStore } from './store/memory-store.js';
import { AttendanceController } from './attendance/attendance.controller.js';
import { AttendanceService } from './attendance/attendance.service.js';
import { LeaveController } from './leave/leave.controller.js';
import { LeaveService } from './leave/leave.service.js';
import { RosterController } from './roster/roster.controller.js';
import { RosterService } from './roster/roster.service.js';
import { HealthController } from './common/health.controller.js';

/**
 * 모듈러 모놀리스.
 *
 * 지금은 하나의 Nest 모듈이지만, 모듈 간 규칙은 처음부터 지킨다:
 * 다른 모듈의 저장소를 직접 조인하지 않고 서비스 인터페이스로만 호출한다.
 * 나중에 분리할 수 있는 상태를 유지하는 것이 목적이다.
 * (docs/03-architecture.md §4.1)
 */
@Module({
  controllers: [HealthController, AttendanceController, LeaveController, RosterController],
  providers: [MemoryStore, AttendanceService, LeaveService, RosterService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).exclude('healthz').forRoutes('*');
  }
}
