import { Download, Folder, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  PERMISSION_SUBJECTS,
  type PermissionMode,
  AGENT_STATUSES,
  VOICE_STATES,
} from '@allaya/types';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { ActivityItem } from '@renderer/components/domain/activity-item';
import { AIStatus } from '@renderer/components/domain/ai-status';
import { AppCard } from '@renderer/components/domain/app-card';
import { AutomationNode } from '@renderer/components/domain/automation-node';
import { FileRow } from '@renderer/components/domain/file-row';
import { ModelCard } from '@renderer/components/domain/model-card';
import { PermissionCard } from '@renderer/components/domain/permission-card';
import { TaskCard } from '@renderer/components/domain/task-card';
import { Timeline } from '@renderer/components/domain/timeline';
import { VoiceVisualizer } from '@renderer/components/domain/voice-visualizer';
import { Avatar } from '@renderer/components/ui/avatar';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card, CardHeader, StatCard } from '@renderer/components/ui/card';
import { ConfirmationDialog } from '@renderer/components/ui/confirmation-dialog';
import { DataTable } from '@renderer/components/ui/data-table';
import { Drawer } from '@renderer/components/ui/drawer';
import { Dropdown } from '@renderer/components/ui/dropdown';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Field, Input, SearchInput, Textarea } from '@renderer/components/ui/input';
import { Kbd } from '@renderer/components/ui/kbd';
import { Modal } from '@renderer/components/ui/modal';
import { Progress } from '@renderer/components/ui/progress';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { Switch } from '@renderer/components/ui/switch';
import { Tabs } from '@renderer/components/ui/tabs';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3" aria-label={title}>
      <h2 className="text-h2 font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

const NOW = Date.now();

/** Living documentation of the design system — every reusable component in every state. */
export function GalleryScreen() {
  const t = useT();
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [on, setOn] = useState(true);
  const [mode, setMode] = useState<PermissionMode>('ask');
  const [choice, setChoice] = useState('claude');
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const focusRef = useRef<HTMLButtonElement>(null);

  return (
    <ScreenFrame title={t.t('gallery.title')} width="wide">
      <div className="space-y-10">
        <Section title={t.t('gallery.buttons')}>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="gradient" leftIcon={<Plus size={16} />}>
              {t.t('nav.newTask')}
            </Button>
            <Button variant="primary">{t.t('common.confirm')}</Button>
            <Button variant="secondary">{t.t('common.cancel')}</Button>
            <Button variant="outline">{t.t('common.details')}</Button>
            <Button variant="ghost">{t.t('common.skip')}</Button>
            <Button variant="danger" leftIcon={<Trash2 size={16} />}>
              {t.t('common.delete')}
            </Button>
            <Button loading>{t.t('common.loading')}</Button>
            <Button disabled>{t.t('common.disabled')}</Button>
            <Button size="sm">sm</Button>
            <Button size="lg">lg</Button>
            <IconButton label={t.t('common.add')} icon={<Plus size={18} />} />
            <IconButton label={t.t('common.export')} icon={<Download size={18} />} active />
          </div>
        </Section>

        <Section title={t.t('gallery.inputs')}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t.t('settings.displayName')} hint={t.t('settings.displayNameHint')}>
              {(p) => <Input {...p} placeholder="Babul" />}
            </Field>
            <Field label={t.t('settings.displayName')} error={t.t('errors.generic')}>
              {(p) => <Input {...p} defaultValue="…" />}
            </Field>
            <SearchInput
              value={search}
              onValueChange={setSearch}
              clearLabel={t.t('common.close')}
              placeholder={t.t('files.searchPlaceholder')}
              aria-label={t.t('common.search')}
            />
            <Dropdown
              label={t.t('chat.model')}
              value={choice}
              onValueChange={setChoice}
              options={[
                { value: 'claude', label: 'Claude', description: t.t('models.providers') },
                { value: 'gpt', label: 'GPT' },
                { value: 'gemini', label: 'Gemini' },
              ]}
            />
            <Textarea
              autoGrow
              aria-label={t.t('home.askLabel')}
              placeholder={t.t('home.askPlaceholder')}
              className="md:col-span-2"
            />
            <div className="flex items-center gap-3">
              <Switch checked={on} onCheckedChange={setOn} label={t.t('common.enabled')} />
              <span className="text-body text-fg">{on ? t.t('common.on') : t.t('common.off')}</span>
              <Kbd>Ctrl</Kbd>
              <Kbd>K</Kbd>
            </div>
          </div>
        </Section>

        <Section title={t.t('gallery.status')}>
          <div className="grid gap-4 md:grid-cols-4">
            {AGENT_STATUSES.map((status) => (
              <Card key={status} className="flex justify-center py-6">
                <AIStatus status={status} />
              </Card>
            ))}
          </div>
          <Card className="grid gap-2 md:grid-cols-5">
            {VOICE_STATES.map((state) => (
              <div key={state} className="flex flex-col items-center gap-2">
                <VoiceVisualizer state={state} bars={18} />
                <span className="text-caption text-muted">{t.t(`voice.${state}`)}</span>
              </div>
            ))}
          </Card>
        </Section>

        <Section title={t.t('gallery.feedback')}>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="neutral">neutral</Badge>
            <Badge tone="accent" dot>
              accent
            </Badge>
            <Badge tone="success" dot>
              {t.t('toast.success')}
            </Badge>
            <Badge tone="warning" dot>
              {t.t('toast.warning')}
            </Badge>
            <Badge tone="danger" dot>
              {t.t('toast.error')}
            </Badge>
            <Badge tone="info">{t.t('toast.info')}</Badge>
            <Avatar name="Babul Alam" />
            <Avatar name="বাবুল" size={40} />
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => toast.success(t.t('toast.taskCompleted'))}>
              {t.t('toast.success')}
            </Button>
            <Button variant="secondary" onClick={() => toast.info(t.t('toast.info'))}>
              {t.t('toast.info')}
            </Button>
            <Button variant="secondary" onClick={() => toast.working(t.t('toast.allayaWorking'))}>
              {t.t('toast.working')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => toast.warning(t.t('toast.confirmationRequired'))}
            >
              {t.t('toast.warning')}
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                toast.error(t.t('errors.generic'), { description: t.t('errors.reason') })
              }
            >
              {t.t('toast.error')}
            </Button>
          </div>
          <div className="space-y-3">
            <Progress label={t.t('status.working')} value={62} />
            <Progress label={t.t('status.working')} />
            <div className="flex gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <Skeleton className="h-10 flex-1" />
            </div>
          </div>
        </Section>

        <Section title={t.t('gallery.data')}>
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard
              label={t.t('tasks.tabs.completed')}
              value={t.formatNumber(12)}
              hint={t.t('tasks.actions', { count: 47 })}
            />
            <StatCard label={t.t('tasks.duration')} value={t.formatDuration(150_000)} />
            <StatCard label={t.t('files.size')} value={t.formatFileSize(1_572_864)} />
          </div>
          <Tabs
            label={t.t('tasks.title')}
            value={tab}
            onValueChange={setTab}
            items={(['all', 'running', 'scheduled', 'completed', 'failed', 'paused'] as const).map(
              (v, i) => ({
                value: v,
                label: t.t(`tasks.tabs.${v}`),
                count: i === 0 ? 12 : undefined,
              }),
            )}
          />
          <DataTable
            caption={t.t('files.title')}
            rowKey={(r) => r.name}
            rows={[
              { name: 'report.pdf', type: 'PDF', size: 2_400_000 },
              { name: 'রিপোর্ট.docx', type: 'DOCX', size: 180_000 },
            ]}
            columns={[
              { id: 'name', header: t.t('files.name'), cell: (r) => r.name },
              { id: 'type', header: t.t('files.type'), cell: (r) => <Badge>{r.type}</Badge> },
              {
                id: 'size',
                header: t.t('files.size'),
                align: 'end',
                cell: (r) => t.formatFileSize(r.size),
              },
            ]}
          />
        </Section>

        <Section title={t.t('gallery.domain')}>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card variant="elevated">
              <CardHeader
                title={t.t('gallery.sampleTask')}
                action={
                  <Badge tone="accent" dot>
                    {t.t('taskState.EXECUTING')}
                  </Badge>
                }
              />
              <Timeline
                steps={[
                  { id: '1', title: t.t('gallery.sampleStep1'), state: 'done', durationMs: 400 },
                  {
                    id: '2',
                    title: t.t('gallery.sampleStep2'),
                    state: 'done',
                    durationMs: 900,
                    detail: 'open_folder { target: "Downloads" }',
                  },
                  { id: '3', title: t.t('gallery.sampleStep3'), state: 'done', durationMs: 1800 },
                  { id: '4', title: t.t('gallery.sampleStep4'), state: 'running' },
                  { id: '5', title: t.t('gallery.sampleStep5'), state: 'pending' },
                ]}
              />
            </Card>
            <div className="space-y-4">
              <TaskCard
                task={{
                  id: '1',
                  title: t.t('gallery.sampleTask'),
                  state: 'FAILED',
                  startedAt: NOW - 300_000,
                  durationMs: 42_000,
                  actionCount: 6,
                  filesChanged: 12,
                }}
                onOpen={() => undefined}
                onRetry={() => undefined}
              />
              <Card>
                <ul className="space-y-4">
                  <ActivityItem
                    entry={{
                      id: 'a',
                      timestamp: NOW - 120_000,
                      actor: 'allaya',
                      text: t.t('quickActions.prompts.open_browser'),
                      result: 'success',
                    }}
                  />
                  <ActivityItem
                    entry={{
                      id: 'b',
                      timestamp: NOW - 60_000,
                      actor: 'user',
                      text: t.t('toast.confirmationRequired'),
                      result: 'pending',
                    }}
                  />
                </ul>
              </Card>
              <Card padded={false} className="p-2">
                <FileRow
                  entry={{
                    path: 'C:\\Users\\Babul\\Downloads\\report.pdf',
                    name: 'report.pdf',
                    isDirectory: false,
                    extension: 'pdf',
                    size: 2_400_000,
                  }}
                />
                <FileRow
                  entry={{
                    path: 'C:\\Users\\Babul\\Downloads',
                    name: 'Downloads',
                    isDirectory: true,
                  }}
                />
              </Card>
            </div>
            <AppCard
              app={{
                id: 'chrome',
                name: 'Chrome',
                installed: true,
                running: true,
                automationSupport: 'uia',
                lastUsedAt: NOW - 3_600_000,
              }}
            />
            <ModelCard
              provider={{
                id: 'anthropic',
                name: 'Anthropic',
                connected: true,
                maskedKey: 'sk-…a1b2',
                models: ['Claude'],
                capabilities: ['vision', 'tools', 'streaming'],
              }}
            />
            <PermissionCard
              subject={PERMISSION_SUBJECTS[0]}
              mode={mode}
              onModeChange={setMode}
              icon={<Folder size={20} />}
            />
            <div className="flex flex-wrap items-center gap-6 rounded-card border border-dashed border-line p-6">
              <AutomationNode kind="trigger" label={t.t('nav.automations')} subtitle="18:00" />
              <AutomationNode kind="human_approval" label={t.t('common.approve')} selected />
            </div>
          </div>
        </Section>

        <Section title={t.t('gallery.dialogs')}>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setModal(true)}>
              {t.t('gallery.openModal')}
            </Button>
            <Button variant="secondary" onClick={() => setDrawer(true)}>
              {t.t('gallery.openDrawer')}
            </Button>
            <Button variant="danger" onClick={() => setConfirm(true)}>
              {t.t('gallery.openConfirm')}
            </Button>
          </div>
        </Section>
      </div>

      <Modal
        open={modal}
        onOpenChange={setModal}
        title={t.t('gallery.openModal')}
        description={t.t('app.tagline')}
        initialFocusRef={focusRef}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModal(false)}>
              {t.t('common.cancel')}
            </Button>
            <Button ref={focusRef} variant="primary" onClick={() => setModal(false)}>
              {t.t('common.done')}
            </Button>
          </>
        }
      >
        <p className="text-body text-muted">{t.t('help.tipsNote')}</p>
      </Modal>
      <Drawer open={drawer} onOpenChange={setDrawer} title={t.t('context.title')}>
        <p className="text-body text-muted">{t.t('context.empty')}</p>
      </Drawer>
      <ConfirmationDialog
        open={confirm}
        risk="HIGH"
        message={t.t('quickActions.prompts.find_file')}
        location="C:\Users\Babul\Downloads\Old Files"
        onCancel={() => setConfirm(false)}
        onConfirm={() => setConfirm(false)}
        onReview={() => setConfirm(false)}
      />
    </ScreenFrame>
  );
}
