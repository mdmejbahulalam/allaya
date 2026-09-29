import {
  Activity,
  AppWindow,
  Bot,
  Brain,
  CircleHelp,
  Cpu,
  FolderOpen,
  Globe,
  House,
  ListChecks,
  MessageSquare,
  MonitorCog,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export const ROUTE_IDS = [
  'home',
  'chat',
  'tasks',
  'automations',
  'computer',
  'apps',
  'browser',
  'files',
  'memory',
  'models',
  'activity',
  'permissions',
  'settings',
  'help',
  'gallery',
] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

export type NavGroupId = 'home' | 'computer' | 'intelligence' | 'system';

export interface RouteDef {
  id: RouteId;
  icon: LucideIcon;
  /** Present for items shown in the primary navigation groups. */
  group?: NavGroupId;
}

export const ROUTES: RouteDef[] = [
  { id: 'home', icon: House, group: 'home' },
  { id: 'chat', icon: MessageSquare, group: 'home' },
  { id: 'tasks', icon: ListChecks, group: 'home' },
  { id: 'automations', icon: Bot, group: 'home' },
  { id: 'computer', icon: MonitorCog, group: 'computer' },
  { id: 'apps', icon: AppWindow, group: 'computer' },
  { id: 'browser', icon: Globe, group: 'computer' },
  { id: 'files', icon: FolderOpen, group: 'computer' },
  { id: 'memory', icon: Brain, group: 'intelligence' },
  { id: 'models', icon: Cpu, group: 'intelligence' },
  { id: 'activity', icon: Activity, group: 'system' },
  { id: 'permissions', icon: ShieldCheck, group: 'system' },
  { id: 'settings', icon: Settings },
  { id: 'help', icon: CircleHelp },
  { id: 'gallery', icon: Settings },
];

export const NAV_GROUPS: NavGroupId[] = ['home', 'computer', 'intelligence', 'system'];

export const routeById = (id: RouteId): RouteDef => ROUTES.find((r) => r.id === id)!;
