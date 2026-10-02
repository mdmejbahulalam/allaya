import { Megaphone, PenLine, Pencil, Plus, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrandProfile, BuiltInSkillView, CustomSkill } from '@allaya/validation';
import { EMPTY_BRAND } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { toast } from '@renderer/stores/toasts';
import { useSettingsStore } from '@renderer/stores/settings';
import { useSkillsStore } from '@renderer/stores/skills';
import { useUiStore } from '@renderer/stores/ui';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';
import { ConfirmationDialog } from '@renderer/components/ui/confirmation-dialog';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { Switch } from '@renderer/components/ui/switch';
import { BrandForm } from './brand-form';
import { emptySkillForm, SkillForm, skillFormFrom, type SkillFormState } from './skill-form';

const SOCIAL_MEDIA_ID = 'social-media-marketing';

function useExplain() {
  const t = useT();
  return (error: unknown): string =>
    error instanceof IpcError && t.has(`errors.ipc.${error.code}`)
      ? t.t(`errors.ipc.${error.code}` as TranslationKey)
      : t.t('errors.ipc.UNKNOWN');
}

/** After a change made through a dedicated channel, take the settings as they now are. */
const sync = async () => useSettingsStore.getState().hydrate(await invoke('settings:getAll'));

function BuiltInCard({
  skill,
  on,
  masterOn,
  brand,
  onToggle,
  onEditBrand,
  onTry,
}: {
  skill: BuiltInSkillView;
  on: boolean;
  masterOn: boolean;
  brand: BrandProfile;
  onToggle: (on: boolean) => void;
  onEditBrand: () => void;
  onTry: (text: string) => void;
}) {
  const t = useT();
  const lang = t.locale;
  const name = skill.name[lang];
  const brandSet = brand.businessName.trim() !== '' || brand.about.trim() !== '';
  return (
    <Card
      className={cn('flex flex-col gap-3', !(on && masterOn) && 'opacity-80')}
      data-testid="skill-card"
      data-skill={skill.id}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent-text"
        >
          {skill.id === SOCIAL_MEDIA_ID ? <Megaphone size={18} /> : <Sparkles size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body font-semibold break-words text-fg">{name}</h3>
            <Badge tone="neutral">
              {t.t(`skills.category.${skill.category}` as TranslationKey)}
            </Badge>
          </div>
          <p className="mt-0.5 text-small text-muted">{skill.summary[lang]}</p>
        </div>
        <Switch
          checked={on}
          disabled={!masterOn}
          label={t.t('skills.use', { name })}
          onCheckedChange={onToggle}
        />
      </div>

      {skill.usesBrand && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2">
          <p className="min-w-0 flex-1 text-small text-muted">
            {brandSet
              ? t.t('skills.brand.summary', { name: brand.businessName.trim() || '—' })
              : t.t('skills.brand.empty')}
          </p>
          <Button size="sm" variant="outline" onClick={onEditBrand}>
            {t.t(brandSet ? 'skills.brand.edit' : 'skills.brand.setUp')}
          </Button>
        </div>
      )}

      <div>
        <p className="mb-1.5 text-caption font-medium text-muted">{t.t('skills.tryTitle')}</p>
        <ul className="flex flex-col gap-1.5">
          {skill.examples.map((example) => (
            <li key={example.en}>
              <button
                type="button"
                disabled={!(on && masterOn)}
                onClick={() => onTry(example[lang])}
                className="w-full rounded-control border border-line px-3 py-2 text-start text-small text-fg transition-colors hover:border-line-strong hover:bg-elevated focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                {example[lang]}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function SkillsScreen() {
  const t = useT();
  const explain = useExplain();
  const catalog = useSkillsStore((s) => s.skills);
  const maxCustom = useSkillsStore((s) => s.maxCustom);
  const load = useSkillsStore((s) => s.load);
  const values = useSettingsStore((s) => s.values);
  const update = useSettingsStore((s) => s.update);
  const navigate = useUiStore((s) => s.navigate);
  const setComposerDraft = useUiStore((s) => s.setComposerDraft);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<SkillFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<CustomSkill | null>(null);
  const [brandOpen, setBrandOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const masterOn = values['skills.enabled'];
  const disabled = values['skills.disabled'];
  const custom = values['skills.custom'];
  const brand = values['skills.brand'] ?? EMPTY_BRAND;
  const atLimit = custom.length >= maxCustom;

  const toggle = (id: string, on: boolean) =>
    void update(
      'skills.disabled',
      on ? disabled.filter((d) => d !== id) : [...new Set([...disabled, id])],
    ).catch((error: unknown) => toast.error(explain(error)));

  const tryIt = (text: string) => {
    setComposerDraft(text);
    navigate('chat');
  };

  const saveSkill = async (skill: Omit<CustomSkill, 'id'> & { id?: string }) => {
    setSaving(true);
    try {
      await invoke('skills:saveCustom', skill);
      await sync();
      setForm(null);
      toast.success(t.t('skills.saved', { name: skill.name }));
    } finally {
      setSaving(false);
    }
  };

  const saveBrand = async (next: BrandProfile) => {
    setSaving(true);
    try {
      await invoke('skills:saveBrand', next);
      await sync();
      setBrandOpen(false);
      toast.success(t.t('skills.brand.saved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenFrame
      title={t.t('skills.title')}
      description={t.t('skills.subtitle')}
      actions={
        <Button
          variant="primary"
          leftIcon={<Plus size={16} />}
          disabled={atLimit}
          onClick={() => setForm(emptySkillForm())}
        >
          {t.t('skills.new')}
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        <Card variant="elevated" className="flex flex-col gap-3">
          <label className="flex items-center gap-3 text-body font-medium text-fg">
            <Switch
              checked={masterOn}
              label={t.t('skills.toggle')}
              onCheckedChange={(on) =>
                void update('skills.enabled', on).catch((error: unknown) =>
                  toast.error(explain(error)),
                )
              }
            />
            {t.t('skills.toggle')}
          </label>
          {!masterOn && (
            <div
              role="status"
              className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2"
            >
              <p className="text-small font-medium text-fg">{t.t('skills.off.title')}</p>
              <p className="text-small text-muted">{t.t('skills.off.body')}</p>
            </div>
          )}
          <div className="flex items-start gap-2 text-small text-muted">
            <ShieldCheck aria-hidden size={16} className="mt-0.5 shrink-0 text-success" />
            <p>
              <span className="font-medium text-fg">{t.t('skills.privacyTitle')}. </span>
              {t.t('skills.privacyBody')}
            </p>
          </div>
        </Card>

        <section aria-labelledby="skills-builtin" className="flex flex-col gap-3">
          <h2 id="skills-builtin" className="text-h2 font-semibold text-fg">
            {t.t('skills.builtIn')}
          </h2>
          {failed ? (
            <Card>
              <p className="text-body text-muted">{t.t('errors.ipc.UNKNOWN')}</p>
            </Card>
          ) : catalog === null ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <ul aria-labelledby="skills-builtin" className="grid gap-3 lg:grid-cols-2">
              {catalog.map((skill) => (
                <li key={skill.id} className="flex">
                  <BuiltInCard
                    skill={skill}
                    on={!disabled.includes(skill.id)}
                    masterOn={masterOn}
                    brand={brand}
                    onToggle={(on) => toggle(skill.id, on)}
                    onEditBrand={() => setBrandOpen(true)}
                    onTry={tryIt}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="skills-mine" className="flex flex-col gap-3">
          <h2 id="skills-mine" className="text-h2 font-semibold text-fg">
            {t.t('skills.mine')}
          </h2>
          {custom.length === 0 ? (
            <Card>
              <EmptyState
                icon={PenLine}
                title={t.t('skills.emptyTitle')}
                description={t.t('skills.emptyBody')}
                action={
                  <Button
                    variant="primary"
                    leftIcon={<Plus size={16} />}
                    onClick={() => setForm(emptySkillForm())}
                  >
                    {t.t('skills.new')}
                  </Button>
                }
              />
            </Card>
          ) : (
            <ul aria-labelledby="skills-mine" className="flex flex-col gap-3">
              {custom.map((skill) => (
                <li key={skill.id}>
                  <Card className="flex items-start gap-3" data-testid="custom-skill">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-body font-semibold break-words text-fg">{skill.name}</h3>
                      <p className="mt-0.5 line-clamp-3 text-small break-words whitespace-pre-wrap text-muted">
                        {skill.instructions}
                      </p>
                      <p className="mt-1 text-caption text-muted">
                        {t.t('skills.usedFor', { words: skill.keywords.join(', ') })}
                      </p>
                    </div>
                    <Switch
                      checked={!disabled.includes(skill.id)}
                      disabled={!masterOn}
                      label={t.t('skills.use', { name: skill.name })}
                      onCheckedChange={(on) => toggle(skill.id, on)}
                    />
                    <span className="flex gap-1">
                      <IconButton
                        label={t.t('skills.editNamed', { name: skill.name })}
                        icon={<Pencil size={16} />}
                        onClick={() => setForm(skillFormFrom(skill))}
                      />
                      <IconButton
                        label={t.t('skills.deleteNamed', { name: skill.name })}
                        icon={<Trash2 size={16} />}
                        onClick={() => setDeleting(skill)}
                      />
                    </span>
                  </Card>
                </li>
              ))}
            </ul>
          )}
          <p className="text-caption text-muted">
            {t.t('skills.count', { count: custom.length, max: maxCustom })}
          </p>
        </section>
      </div>

      <SkillForm initial={form} busy={saving} onSubmit={saveSkill} onCancel={() => setForm(null)} />
      <BrandForm
        open={brandOpen}
        initial={brand}
        busy={saving}
        onSubmit={saveBrand}
        onCancel={() => setBrandOpen(false)}
      />
      <ConfirmationDialog
        open={deleting !== null}
        risk="MEDIUM"
        message={t.t('skills.deleteBody', { name: deleting?.name ?? '' })}
        confirmLabel={t.t('skills.delete')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (!target) return;
          void invoke('skills:deleteCustom', { id: target.id })
            .then(async () => {
              await sync();
              toast.success(t.t('skills.deleted', { name: target.name }));
            })
            .catch((error: unknown) => toast.error(explain(error)));
        }}
      />
    </ScreenFrame>
  );
}
