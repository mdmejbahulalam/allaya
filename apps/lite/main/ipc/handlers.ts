import { Handlers } from './dispatcher';
import type { ChatService } from '../core/chat';
import type { ConnectionService } from '../core/connections';
import type { BrowserService } from '../browser/service';
import type { McpService } from '../mcp/service';
import type { ApprovalService } from '../core/approvals';
import type { TaskService } from '../core/tasks';
import type { SettingsStore } from '../core/settings';
import type { VoiceService } from '../core/voice';

export interface AppInfo {
  version: string;
  platform: string;
  locale: string;
  e2e: boolean;
}

export interface Services {
  settings: SettingsStore;
  connections: ConnectionService;
  chat: ChatService;
  voice: VoiceService;
  browser: BrowserService;
  tasks: TaskService;
  approvals: ApprovalService;
  mcp: McpService;
  info: AppInfo;
}

/** Wires every channel in the contract to the service that answers it. */
export function createHandlers(s: Services): Handlers {
  return new Handlers()
    .register('app:info', () => s.info)
    .register('settings:get', () => s.settings.get())
    .register('settings:set', (changes) => s.settings.set(changes))

    .register('connections:list', () => s.connections.list())
    .register('connections:add', (input) => s.connections.add(input))
    .register('connections:update', (input) => s.connections.update(input))
    .register('connections:remove', ({ id }) => {
      s.connections.remove(id);
      return { ok: true as const };
    })
    .register('connections:test', ({ id }) => s.connections.test(id))
    .register('models:list', ({ refresh }) => s.connections.models({ refresh }))

    .register('chats:list', () => s.chat.list())
    .register('chats:get', ({ id }) => s.chat.get(id))
    .register('chats:create', ({ model }) => s.chat.create(model))
    .register('chats:rename', ({ id, title }) => s.chat.rename(id, title))
    .register('chats:setModel', ({ id, model }) => s.chat.setModel(id, model))
    .register('chats:remove', ({ id }) => {
      s.chat.remove(id);
      return { ok: true as const };
    })

    .register('chat:send', (input) => s.chat.send(input))
    .register('chat:cancel', ({ chatId }) => {
      s.chat.cancel(chatId);
      return { ok: true as const };
    })

    .register('tasks:list', () => s.tasks.list())
    .register('tasks:get', ({ id }) => s.tasks.get(id))
    .register('tasks:create', (input) => s.tasks.create(input))
    .register('tasks:update', ({ id, changes }) => s.tasks.update(id, changes))
    .register('tasks:remove', ({ id }) => {
      s.tasks.remove(id);
      return { ok: true as const };
    })
    .register('tasks:run', ({ id }) => s.tasks.run(id, 'manual'))
    .register('tasks:cancel', ({ runId }) => {
      s.tasks.cancel(runId);
      return { ok: true as const };
    })
    .register('approvals:list', () => s.approvals.list())
    .register('approvals:decide', ({ id, allow }) => {
      s.approvals.decide(id, allow);
      return { ok: true as const };
    })

    .register('mcp:list', () => s.mcp.list())
    .register('mcp:add', (input) => s.mcp.add(input))
    .register('mcp:update', ({ id, changes }) => s.mcp.update(id, changes))
    .register('mcp:remove', ({ id }) => {
      s.mcp.remove(id);
      return { ok: true as const };
    })
    .register('mcp:reconnect', async ({ id }) => {
      await s.mcp.connect(id);
      return s.mcp.get(id);
    })
    .register('mcp:signIn', ({ id }) => s.mcp.signIn(id))
    .register('mcp:cancelSignIn', ({ id }) => {
      s.mcp.cancelSignIn(id);
      return { ok: true as const };
    })
    .register('mcp:signOut', ({ id }) => s.mcp.signOut(id))
    .register('mcp:setTool', ({ id, tool, ask, enabled }) =>
      s.mcp.setTool(id, tool, { ask, enabled }),
    )

    .register('browser:state', () => s.browser.state())
    .register('browser:go', ({ input }) => {
      s.browser.go(input);
      return { ok: true as const };
    })
    .register('browser:newTab', ({ input }) => {
      s.browser.newTab(input);
      return { ok: true as const };
    })
    .register('browser:close', ({ id }) => {
      s.browser.close(id);
      return { ok: true as const };
    })
    .register('browser:activate', ({ id }) => {
      s.browser.activate(id);
      return { ok: true as const };
    })
    .register('browser:back', ({ id }) => {
      s.browser.back(id);
      return { ok: true as const };
    })
    .register('browser:forward', ({ id }) => {
      s.browser.forward(id);
      return { ok: true as const };
    })
    .register('browser:reload', ({ id }) => {
      s.browser.reload(id);
      return { ok: true as const };
    })
    .register('browser:stop', ({ id }) => {
      s.browser.stop(id);
      return { ok: true as const };
    })
    .register('browser:bounds', ({ visible, ...bounds }) => {
      s.browser.setBounds(bounds, visible);
      return { ok: true as const };
    })

    .register('voice:options', () => s.voice.options())
    .register('voice:transcribe', (input) => s.voice.transcribe(input))
    .register('voice:synthesize', (input) => s.voice.synthesize(input));
}
