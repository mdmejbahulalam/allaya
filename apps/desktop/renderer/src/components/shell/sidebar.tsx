import { PanelLeftClose, PanelLeftOpen, Pin, PinOff, Plus } from 'lucide-react';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { NAV_GROUPS, ROUTES, routeById, type RouteDef, type RouteId } from '@renderer/app/routes';
import { Button } from '@renderer/components/ui/button';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { needsAttention, useTasksStore } from '@renderer/stores/tasks';

function NavItem({
  route,
  collapsed,
  active,
  onNavigate,
}: {
  route: RouteDef;
  collapsed: boolean;
  active: boolean;
  onNavigate: (id: RouteId) => void;
}) {
  const t = useT();
  const label = t.t(`nav.${route.id as 'home'}`);
  const Icon = route.icon;
  // Tasks waiting for the person are visible from anywhere in the app.
  const waiting = useTasksStore((s) =>
    route.id === 'tasks' ? Object.values(s.byId).filter(needsAttention).length : 0,
  );
  return (
    <Tooltip label={label} side="right" disabled={!collapsed}>
      <button
        type="button"
        onClick={() => onNavigate(route.id)}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? label : undefined}
        className={cn(
          'group relative flex h-10 w-full items-center gap-3 rounded-control px-3 text-body font-medium',
          'transition-colors duration-150',
          collapsed && 'justify-center px-0',
          active ? 'bg-elevated text-fg' : 'text-muted hover:bg-elevated/60 hover:text-fg',
        )}
      >
        {active && (
          <span
            aria-hidden
            className="gradient-accent absolute start-0 top-2 bottom-2 w-[3px] rounded-full"
          />
        )}
        <Icon aria-hidden size={20} className={cn('shrink-0', active && 'text-accent-text')} />
        {!collapsed && <span className="truncate">{label}</span>}
        {waiting > 0 && (
          <span
            data-testid="tasks-waiting"
            className={cn(
              'flex min-w-5 items-center justify-center rounded-pill bg-warning px-1.5 text-caption font-semibold text-black tabular-nums',
              collapsed ? 'absolute end-2 top-1.5 min-w-4 px-1 text-[10px]' : 'ms-auto',
            )}
          >
            <span aria-hidden>{waiting}</span>
            <span className="sr-only">{t.t('tasks.needsYou', { count: waiting })}</span>
          </span>
        )}
      </button>
    </Tooltip>
  );
}

export interface SidebarProps {
  route: RouteId;
  collapsed: boolean;
  /** Whether the user pinned the sidebar open (vs. hover-to-expand). */
  pinned: boolean;
  /** Expanded because of hover while unpinned: render as an overlay. */
  overlay: boolean;
  onNavigate: (id: RouteId) => void;
  onNewTask: () => void;
  onToggleCollapsed: () => void;
  onTogglePinned: () => void;
  /** Small windows force the collapsed state; hide the toggle then. */
  canToggle: boolean;
}

export function Sidebar({
  route,
  collapsed,
  pinned,
  overlay,
  onNavigate,
  onNewTask,
  onToggleCollapsed,
  onTogglePinned,
  canToggle,
}: SidebarProps) {
  const t = useT();
  return (
    <nav
      aria-label={t.t('nav.primary')}
      className={cn(
        'flex h-full flex-col border-e border-line bg-bg-2 transition-[width] duration-200 ease-out-soft',
        collapsed ? 'w-[72px]' : 'w-[248px]',
        overlay && 'shadow-elevated',
      )}
    >
      <div className={cn('p-3', collapsed && 'flex justify-center')}>
        {collapsed ? (
          <Tooltip label={t.t('nav.newTask')} side="right">
            <Button
              variant="gradient"
              size="md"
              aria-label={t.t('nav.newTask')}
              onClick={onNewTask}
              className="size-10 p-0"
            >
              <Plus aria-hidden size={20} />
            </Button>
          </Tooltip>
        ) : (
          <Button
            variant="gradient"
            className="w-full"
            leftIcon={<Plus aria-hidden size={18} />}
            onClick={onNewTask}
          >
            {t.t('nav.newTask')}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3">
        {NAV_GROUPS.map((group) => (
          <section key={group} aria-label={t.t(`nav.groups.${group}`)}>
            {collapsed ? (
              <div aria-hidden className="mx-3 mb-2 h-px bg-line" />
            ) : (
              <h2 className="mb-1.5 px-3 text-caption font-semibold tracking-wider text-muted uppercase">
                {t.t(`nav.groups.${group}`)}
              </h2>
            )}
            <ul className="space-y-0.5">
              {ROUTES.filter((r) => r.group === group).map((r) => (
                <li key={r.id}>
                  <NavItem
                    route={r}
                    collapsed={collapsed}
                    active={route === r.id}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="space-y-0.5 border-t border-line p-3">
        {(['settings', 'help'] as const).map((id) => (
          <NavItem
            key={id}
            route={routeById(id)}
            collapsed={collapsed}
            active={route === id}
            onNavigate={onNavigate}
          />
        ))}
        {canToggle && (
          <div
            className={cn(
              'flex pt-1',
              collapsed ? 'flex-col items-center gap-1' : 'items-center justify-between',
            )}
          >
            <IconButton
              size="sm"
              label={collapsed ? t.t('nav.expand') : t.t('nav.collapse')}
              tooltipSide="right"
              icon={collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              onClick={onToggleCollapsed}
            />
            <IconButton
              size="sm"
              label={pinned ? t.t('nav.unpin') : t.t('nav.pin')}
              tooltipSide="right"
              active={pinned}
              icon={pinned ? <Pin size={16} /> : <PinOff size={16} />}
              onClick={onTogglePinned}
            />
          </div>
        )}
      </div>
    </nav>
  );
}
