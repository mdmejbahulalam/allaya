import { lazy } from 'react';
import type { ComponentType } from 'react';
import type { RouteId } from '@renderer/app/routes';
import { EmptyScreen } from './placeholder';
import { Activity, AppWindow, Bot, Brain, Globe, ListChecks, ShieldCheck } from 'lucide-react';

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
  tasks: () => (
    <EmptyScreen
      icon={ListChecks}
      titleKey="tasks.title"
      emptyTitleKey="tasks.emptyTitle"
      emptyBodyKey="tasks.emptyBody"
    />
  ),
  automations: () => (
    <EmptyScreen
      icon={Bot}
      titleKey="automations.title"
      emptyTitleKey="automations.emptyTitle"
      emptyBodyKey="automations.emptyBody"
    />
  ),
  computer: lazyNamed(() => import('./computer/computer-screen'), 'ComputerScreen'),
  apps: () => (
    <EmptyScreen
      icon={AppWindow}
      titleKey="apps.title"
      emptyTitleKey="apps.emptyTitle"
      emptyBodyKey="apps.emptyBody"
    />
  ),
  browser: () => (
    <EmptyScreen
      icon={Globe}
      titleKey="browser.title"
      emptyTitleKey="browser.emptyTitle"
      emptyBodyKey="browser.emptyBody"
    />
  ),
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
