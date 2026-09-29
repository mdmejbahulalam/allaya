import {
  FolderOpen,
  Globe,
  Search,
  Camera,
  AppWindow,
  Zap,
  Paperclip,
  SendHorizontal,
  KeyRound,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useGreeting, useT } from '@renderer/lib/i18n';
import { useUiStore } from '@renderer/stores/ui';
import { selectHasConnected, useProvidersStore } from '@renderer/stores/providers';
import { useSettingsStore } from '@renderer/stores/settings';
import { useAgentStore } from '@renderer/stores/agent';
import { isFinished, sortTasks, useTasksStore } from '@renderer/stores/tasks';
import { TaskCard } from '@renderer/components/domain/task-card';
import { Progress } from '@renderer/components/ui/progress';
import { progressOf } from '../tasks/task-utils';
import { AIStatus } from '@renderer/components/domain/ai-status';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Textarea } from '@renderer/components/ui/input';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { ListChecks } from 'lucide-react';
import { VoiceButton } from '../voice/voice-button';
import { VoicePanel } from '../voice/voice-panel';

const QUICK_ICONS = {
  open_folder: FolderOpen,
  open_browser: Globe,
  open_app: AppWindow,
  screenshot: Camera,
  find_file: Search,
  run_task: Zap,
} as const;

export function HomeScreen() {
  const t = useT();
  const greeting = useGreeting();
  const navigate = useUiStore((s) => s.navigate);
  const setComposerDraft = useUiStore((s) => s.setComposerDraft);
  const quickActions = useSettingsStore((s) => s.values['general.quickActions']);
  const { status, detail } = useAgentStore();
  const tasksById = useTasksStore((s) => s.byId);
  const selectTask = useTasksStore((s) => s.select);
  const recentTasks = useMemo(() => sortTasks(tasksById).slice(0, 3), [tasksById]);
  const currentTask = useMemo(
    () => sortTasks(tasksById).find((task) => !isFinished(task) && task.state !== 'PAUSED'),
    [tasksById],
  );
  const openTask = (id: string) => {
    selectTask(id);
    navigate('tasks');
  };
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setComposerDraft(value);
    setText('');
    navigate('chat');
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10 lg:px-8">
      <header>
        <h1 className="text-display font-semibold tracking-tight text-fg">{greeting}</h1>
        <p className="mt-1 text-h2 text-muted">{t.t('home.headline')}</p>
      </header>

      <VoicePanel />
      <Card variant="elevated" className="p-5">
        <label htmlFor="home-ask" className="mb-2 block text-small font-medium text-muted">
          {t.t('home.commandCardTitle')}
        </label>
        <Textarea
          id="home-ask"
          ref={inputRef}
          autoGrow
          rows={2}
          maxRows={6}
          value={text}
          placeholder={t.t('home.askPlaceholder')}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter inserts a newline; never send mid-IME composition (Bengali input).
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="border-transparent bg-transparent px-0 text-h3 hover:border-transparent focus:border-transparent focus:ring-0"
        />
        <div className="mt-3 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Tooltip label={t.t('home.attachSoon')}>
              <span>
                <IconButton
                  label={t.t('home.attach')}
                  icon={<Paperclip size={18} />}
                  disabled
                  hideTooltip
                />
              </span>
            </Tooltip>
          </div>
          <div className="flex items-center gap-2">
            <VoiceButton />
            <Button
              variant="gradient"
              size="md"
              disabled={!text.trim()}
              onClick={submit}
              aria-label={t.t('home.send')}
            >
              <SendHorizontal aria-hidden size={18} />
            </Button>
          </div>
        </div>
      </Card>

      <Card className="flex items-center justify-between gap-4">
        <div>
          <h2 className="mb-2 text-caption font-semibold tracking-wider text-muted uppercase">
            {t.t('home.currentTask')}
          </h2>
          {currentTask ? (
            <button
              type="button"
              onClick={() => openTask(currentTask.id)}
              className="flex w-full min-w-0 flex-col gap-1.5 text-start"
            >
              <span className="truncate text-body font-medium text-fg">{currentTask.title}</span>
              {progressOf(currentTask) !== undefined && (
                <Progress
                  value={progressOf(currentTask)}
                  label={t.t('tasks.progress', {
                    done: currentTask.stepsDone,
                    total: currentTask.stepCount,
                  })}
                />
              )}
              <span className="text-caption text-muted">
                {t.t(`taskState.${currentTask.state}`)}
              </span>
            </button>
          ) : (
            <AIStatus variant="inline" status={status} {...(detail ? { detail } : {})} />
          )}
        </div>
        {status === 'ready' && (
          <p className="hidden text-small text-muted md:block">{t.t('home.tryExample')}</p>
        )}
      </Card>

      <NoProviderNotice />

      <section aria-labelledby="quick-actions-heading">
        <h2 id="quick-actions-heading" className="mb-3 text-h3 font-semibold text-fg">
          {t.t('home.quickActions')}
        </h2>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {quickActions.map((action) => {
            const Icon = QUICK_ICONS[action];
            return (
              <li key={action}>
                <button
                  type="button"
                  onClick={() => {
                    setText(t.t(`quickActions.prompts.${action}`));
                    inputRef.current?.focus();
                  }}
                  className="group flex w-full items-center gap-3 rounded-card border border-line bg-card p-4 text-start transition-[border-color,background-color] duration-200 hover:border-line-strong hover:bg-elevated"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-elevated text-accent-text transition-colors group-hover:border-accent/40">
                    <Icon aria-hidden size={20} />
                  </span>
                  <span className="text-body font-medium text-fg">
                    {t.t(`quickActions.${action}`)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="recent-tasks-heading">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="recent-tasks-heading" className="text-h3 font-semibold text-fg">
            {t.t('home.recentTasks')}
          </h2>
          <Button variant="ghost" size="sm" onClick={() => navigate('tasks')}>
            {t.t('home.viewAllTasks')}
          </Button>
        </div>
        {recentTasks.length === 0 ? (
          <Card className="flex items-center gap-4 border-dashed">
            <span className="flex size-10 items-center justify-center rounded-xl bg-elevated text-muted">
              <ListChecks aria-hidden size={20} />
            </span>
            <div>
              <p className="text-body font-medium text-fg">{t.t('tasks.emptyTitle')}</p>
              <p className="text-small text-muted">{t.t('tasks.emptyBody')}</p>
            </div>
          </Card>
        ) : (
          <ul className="flex flex-col gap-3">
            {recentTasks.map((task) => (
              <li key={task.id}>
                <TaskCard
                  task={{
                    id: task.id,
                    title: task.title,
                    state: task.state,
                    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
                    ...(task.startedAt !== undefined && task.completedAt !== undefined
                      ? { durationMs: task.completedAt - task.startedAt }
                      : {}),
                    actionCount: task.actionCount,
                    filesChanged: task.filesChanged,
                  }}
                  onOpen={() => openTask(task.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** No-API-key mode (§102): Allaya launches fine without a provider; local features still work. */
function NoProviderNotice() {
  const t = useT();
  const hasConnected = useProvidersStore(selectHasConnected);
  const loaded = useProvidersStore((s) => s.loaded);
  const navigate = useUiStore((s) => s.navigate);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || hasConnected || !loaded) return null;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-4 border-warning/30 bg-warning/5">
      <div className="flex items-start gap-3">
        <KeyRound aria-hidden size={20} className="mt-0.5 shrink-0 text-warning" />
        <div>
          <p className="text-body font-medium text-fg">{t.t('home.noProviderTitle')}</p>
          <p className="text-small text-muted">{t.t('home.noProviderBody')}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={() => navigate('models')}>
          {t.t('home.configureAi')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
          {t.t('home.continueLocal')}
        </Button>
      </div>
    </Card>
  );
}
