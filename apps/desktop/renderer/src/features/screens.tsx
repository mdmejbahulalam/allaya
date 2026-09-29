import { lazy } from 'react';
import type { ComponentType } from 'react';
import type { RouteId } from '@renderer/app/routes';
import { EmptyScreen } from './placeholder';
import { Activity, AppWindow, Brain, ShieldCheck } from 'lucide-react';

const lazyNamed = <T extends Record<string, ComponentType>>(
  loader: () => Promise<T>,
  name: keyof T,
) => lazy(async () => ({ default: (await loader())[name] as ComponentType }));

/** Screens are code-split so startup only pays for the first screen. */
export const SCREENS: Record<RouteId, ComponentType> = {
  home: lazyNamed(() => import('./home/home-screen'), 'HomeScreen'),
  settings: lazyNamed(() => import('./settings/settings-screen'), 'SettingsScreen'),
  help: lazyNamed(() => import('./help/help-screen'), 'HelpScreen'),
  gallery: lazyNamed(() => import('./gallery/gallery-screen'), 'GalleryScreen'),
  chat: lazyNamed(() => import('./chat/chat-screen'), 'ChatScreen'),
  tasks: lazyNamed(() => import('./tasks/tasks-screen'), 'TasksScreen'),
  automations: lazyNamed(() => import('./automations/automations-screen'), 'AutomationsScreen'),
  computer: lazyNamed(() => import('./computer/computer-screen'), 'ComputerScreen'),
  apps: () => (
    <EmptyScreen
      icon={AppWindow}
      titleKey="apps.title"
      emptyTitleKey="apps.emptyTitle"
      emptyBodyKey="apps.emptyBody"
    />
  ),
  browser: lazyNamed(() => import('./browser/browser-screen'), 'BrowserScreen'),
  files: lazyNamed(() => import('./files/files-screen'), 'FilesScreen'),
  memory: () => (
    <EmptyScreen
      icon={Brain}
      titleKey="memory.title"
      emptyTitleKey="memory.emptyTitle"
      emptyBodyKey="memory.emptyBody"
    />
  ),
  models: lazyNamed(() => import('./models/models-screen'), 'ModelsScreen'),
  activity: () => (
    <EmptyScreen
      icon={Activity}
      titleKey="activity.title"
      emptyTitleKey="activity.emptyTitle"
      emptyBodyKey="activity.emptyBody"
    />
  ),
  permissions: () => (
    <EmptyScreen
      icon={ShieldCheck}
      titleKey="permissions.title"
      emptyTitleKey="settings.comingSoonTitle"
      emptyBodyKey="settings.comingSoonBody"
    />
  ),
};
