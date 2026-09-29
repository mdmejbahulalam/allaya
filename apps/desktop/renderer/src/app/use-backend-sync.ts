import { useEffect, useRef } from 'react';
import { invoke, subscribe } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { useAutomationsStore } from '@renderer/stores/automations';
import { useMemoryStore } from '@renderer/stores/memory';
import { useSafetyStore } from '@renderer/stores/safety';
import { useVoiceStore } from '@renderer/stores/voice';
import { useTasksStore } from '@renderer/stores/tasks';
import { useUiStore } from '@renderer/stores/ui';
import { useAgentStore } from '@renderer/stores/agent';
import { useChatStore } from '@renderer/stores/chat';
import { useProvidersStore } from '@renderer/stores/providers';
import { useToolsStore } from '@renderer/stores/tools';

/**
 * Subscribes the renderer's stores to main-process events for the lifetime of the app. Events are the
 * single source of truth for backend state: the UI never polls.
 */
export function useBackendSync(): void {
  const t = useT();
  // The listeners below live as long as the app; they read the current translator when an event arrives.
  const translator = useRef(t);
  useEffect(() => {
    translator.current = t;
  }, [t]);

  useEffect(() => {
    const offs = [
      subscribe('providers:changed', (list) => {
        useProvidersStore.getState().setProviders(list);
        void useProvidersStore.getState().loadRouting();
      }),
      subscribe('agent:status', ({ status, detail, activeRuns }) => {
        const agent = useAgentStore.getState();
        agent.setStatus(status, detail);
        // A run is in flight if the backend says so, even between status transitions.
        if (activeRuns > 0 && !agent.isWorking) agent.setStatus('working', detail);
      }),
      subscribe('chat:delta', ({ messageId, text }) =>
        useChatStore.getState().applyDelta(messageId, text),
      ),
      subscribe('tools:confirmationRequested', (view) => useToolsStore.getState().addPending(view)),
      subscribe('tools:confirmationResolved', ({ id }) =>
        useToolsStore.getState().resolvePending(id),
      ),
      subscribe('tools:activity', ({ messageId, action }) =>
        useToolsStore.getState().applyActivity(messageId, action),
      ),
      subscribe('chat:finished', ({ message }) => useChatStore.getState().applyFinished(message)),
      subscribe(
        'chat:conversationsChanged',
        () => void useChatStore.getState().loadConversations(),
      ),
      subscribe('tasks:changed', (task) => {
        const previous = useTasksStore.getState().apply(task);
        // Only a change the person has not seen yet is worth a notification.
        if (!previous || previous.state === task.state) return;
        const say = translator.current;
        const open = () => {
          useTasksStore.getState().select(task.id);
          useUiStore.getState().navigate('tasks');
        };
        const action = { actionLabel: say.t('tasks.toast.open'), onAction: open };
        if (task.state === 'COMPLETED') {
          if (task.outcome === 'partial') {
            toast.warning(say.t('tasks.toast.partial', { title: task.title }), action);
          } else toast.success(say.t('tasks.toast.completed', { title: task.title }), action);
        } else if (task.state === 'FAILED') {
          toast.error(say.t('tasks.toast.failed', { title: task.title }), action);
        } else if (task.state === 'WAITING_FOR_USER') {
          toast.warning(say.t('tasks.toast.waiting', { title: task.title }), action);
        }
      }),
      subscribe('tasks:removed', ({ ids }) => useTasksStore.getState().removeMany(ids)),
      subscribe(
        'automations:changed',
        () =>
          void useAutomationsStore
            .getState()
            .load()
            .catch(() => undefined),
      ),
      subscribe('activity:changed', () => useSafetyStore.getState().bumpActivity()),
      subscribe('agent:safetyChanged', () => useSafetyStore.getState().bumpSafety()),
      // The system-wide emergency-stop key was pressed, possibly while another program was in front.
      subscribe('agent:stopped', () => {
        // Main has stopped the runs; the microphone and speech live here, so silence them too.
        useVoiceStore.getState().interrupt();
        toast.info(translator.current.t('header.stoppedToast'));
      }),
      subscribe(
        'memory:changed',
        () =>
          void useMemoryStore
            .getState()
            .load()
            .catch(() => undefined),
      ),
    ];
    void Promise.all([
      useProvidersStore.getState().load(),
      useProvidersStore.getState().loadRouting(),
      useChatStore.getState().loadConversations(),
      useTasksStore.getState().load(),
      invoke('agent:getStatus').then(({ status }) => useAgentStore.getState().setStatus(status)),
    ]).catch(() => undefined);
    return () => offs.forEach((off) => off());
  }, []);
}
