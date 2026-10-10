import { Handlers } from './dispatcher';
import type { ChatService } from '../core/chat';
import type { ConnectionService } from '../core/connections';
import type { SettingsStore } from '../core/settings';

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
    });
}
