import { useEffect } from 'react';
import { invoke, subscribe } from '@renderer/lib/api';
import { useAgentStore } from '@renderer/stores/agent';
import { useChatStore } from '@renderer/stores/chat';
import { useProvidersStore } from '@renderer/stores/providers';
import { useToolsStore } from '@renderer/stores/tools';

/**
 * Subscribes the renderer's stores to main-process events for the lifetime of the app. Events are the
 * single source of truth for backend state: the UI never polls.
 */
export function useBackendSync(): void {
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
    ];
    void Promise.all([
      useProvidersStore.getState().load(),
      useProvidersStore.getState().loadRouting(),
      useChatStore.getState().loadConversations(),
      invoke('agent:getStatus').then(({ status }) => useAgentStore.getState().setStatus(status)),
    ]).catch(() => undefined);
    return () => offs.forEach((off) => off());
  }, []);
}
