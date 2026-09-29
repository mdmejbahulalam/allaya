import type { HandlerRegistry } from '../registry';
import type { TaskService } from '../../services/task-service';

export function registerTaskHandlers(registry: HandlerRegistry, tasks: TaskService): void {
  registry
    .register('tasks:list', (payload) => tasks.list(payload?.limit))
    .register('tasks:get', ({ id }) => tasks.get(id))
    .register('tasks:create', ({ request, planFirst }) =>
      tasks.create({ request, planFirst, source: 'palette' }),
    )
    .register('tasks:approve', ({ id }) => {
      tasks.approve(id);
      return { ok: true as const };
    })
    .register('tasks:reject', ({ id }) => {
      tasks.reject(id);
      return { ok: true as const };
    })
    .register('tasks:answer', ({ id, text }) => {
      tasks.answer(id, text);
      return { ok: true as const };
    })
    .register('tasks:pause', ({ id }) => ({ paused: tasks.pause(id) }))
    .register('tasks:resume', ({ id }) => {
      tasks.resume(id);
      return { ok: true as const };
    })
    .register('tasks:cancel', ({ id }) => ({ cancelled: tasks.cancel(id) }))
    .register('tasks:remove', ({ id }) => ({ removed: tasks.remove(id) }))
    .register('tasks:clearFinished', () => ({ removed: tasks.clearFinished() }));
}
