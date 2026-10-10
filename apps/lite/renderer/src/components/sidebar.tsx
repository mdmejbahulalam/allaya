import { ListChecks, Plus, Settings, Trash2 } from 'lucide-react';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { useAppStore } from '../stores/app';
import { useChatStore } from '../stores/chat';
import { useTasksStore } from '../stores/tasks';

export function Sidebar() {
  const t = useT();
  const { chats, activeId } = useChatStore();
  const open = useChatStore((s) => s.open);
  const startNew = useChatStore((s) => s.startNew);
  const remove = useChatStore((s) => s.remove);
  const route = useAppStore((s) => s.route);
  const go = useAppStore((s) => s.go);
  const running = useTasksStore((s) => s.tasks.filter((x) => x.running).length);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-e border-line bg-panel">
      <div className="px-4 pt-4 pb-2">
        <p className="text-lg font-semibold tracking-tight">
          <span aria-hidden className="me-1.5 text-accent">
            ✦
          </span>
          <span>{t.t('app.name')}</span>
        </p>
      </div>
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => {
            startNew();
            go('chat');
          }}
          className="flex w-full items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-sm font-medium transition-colors hover:bg-elevated"
        >
          <Plus size={16} aria-hidden />
          {t.t('nav.newChat')}
        </button>
      </div>
      <div className="px-3 pb-2">
        <button
          type="button"
          aria-current={route === 'tasks' ? 'page' : undefined}
          onClick={() => go('tasks')}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-elevated',
            route === 'tasks' && 'bg-elevated font-medium',
          )}
        >
          <ListChecks size={16} aria-hidden />
          {t.t('nav.tasks')}
          {running > 0 && (
            <span
              role="status"
              aria-label={t.t('nav.tasksRunning', { count: running })}
              title={t.t('nav.tasksRunning', { count: running })}
              className="ms-auto inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs text-accent-fg"
            >
              {running}
            </span>
          )}
        </button>
      </div>
      <nav aria-label={t.t('nav.primary')} className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {chats.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted">{t.t('nav.noChats')}</p>
        ) : (
          <ul className="space-y-0.5">
            {chats.map((chat) => {
              const current = route === 'chat' && chat.id === activeId;
              return (
                <li key={chat.id} className="group/chat relative">
                  <button
                    type="button"
                    aria-current={current ? 'page' : undefined}
                    onClick={() => {
                      go('chat');
                      void open(chat.id);
                    }}
                    className={cn(
                      'block w-full truncate rounded-lg px-3 py-1.5 pe-9 text-start text-sm transition-colors hover:bg-elevated',
                      current && 'bg-elevated font-medium',
                    )}
                    dir="auto"
                  >
                    {chat.title}
                  </button>
                  <button
                    type="button"
                    aria-label={t.t('nav.deleteChat', { title: chat.title })}
                    onClick={() => void remove(chat.id)}
                    className="absolute inset-y-0 end-1 my-auto hidden size-7 items-center justify-center rounded text-muted group-hover/chat:inline-flex hover:text-danger focus-visible:inline-flex"
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
      <div className="border-t border-line p-2">
        <button
          type="button"
          aria-current={route === 'settings' ? 'page' : undefined}
          onClick={() => go('settings')}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-elevated',
            route === 'settings' && 'bg-elevated font-medium',
          )}
        >
          <Settings size={16} aria-hidden />
          {t.t('nav.settings')}
        </button>
      </div>
    </aside>
  );
}
