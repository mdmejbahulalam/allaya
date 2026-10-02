import { lazy } from 'react';
import type { ComponentType } from 'react';
import type { RouteId } from '@renderer/app/routes';

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
  apps: lazyNamed(() => import('./apps/apps-screen'), 'AppsScreen'),
  browser: lazyNamed(() => import('./browser/browser-screen'), 'BrowserScreen'),
  files: lazyNamed(() => import('./files/files-screen'), 'FilesScreen'),
  memory: lazyNamed(() => import('./memory/memory-screen'), 'MemoryScreen'),
  skills: lazyNamed(() => import('./skills/skills-screen'), 'SkillsScreen'),
  models: lazyNamed(() => import('./models/models-screen'), 'ModelsScreen'),
  activity: lazyNamed(() => import('./activity/activity-screen'), 'ActivityScreen'),
  permissions: lazyNamed(() => import('./permissions/permissions-screen'), 'PermissionsScreen'),
};
