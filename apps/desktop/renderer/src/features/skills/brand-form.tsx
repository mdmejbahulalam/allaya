import { useId, useRef, useState } from 'react';
import { EMPTY_BRAND, SOCIAL_PLATFORMS, type BrandProfile } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { Button } from '@renderer/components/ui/button';
import { Input, Textarea } from '@renderer/components/ui/input';
import { Modal } from '@renderer/components/ui/modal';

type Text = Exclude<keyof BrandProfile, 'platforms'>;
const FIELDS: Array<{ key: Text; long?: boolean }> = [
  { key: 'businessName' },
  { key: 'about', long: true },
  { key: 'audience', long: true },
  { key: 'tone' },
  { key: 'languages' },
  { key: 'goals', long: true },
  { key: 'avoid', long: true },
];

/** Who the business is, for the social media skill. Everything is optional; the backend checks it again. */
export function BrandForm({
  open,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  initial: BrandProfile;
  busy: boolean;
  /** Rejects with the backend's error; the form shows it and stays open. */
  onSubmit: (brand: BrandProfile) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const ids = useId();
  const [form, setForm] = useState<BrandProfile>(initial);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(initial);
      setError(null);
    }
  }
  const firstRef = useRef<HTMLInputElement>(null);

  const togglePlatform = (platform: (typeof SOCIAL_PLATFORMS)[number]) =>
    setForm((current) => ({
      ...current,
      platforms: current.platforms.includes(platform)
        ? current.platforms.filter((p) => p !== platform)
        : [...current.platforms, platform],
    }));

  const save = async (brand: BrandProfile) => {
    setError(null);
    try {
      await onSubmit(brand);
    } catch (caught) {
      const reason = caught instanceof IpcError ? caught.details?.['reason'] : undefined;
      if (reason === 'looks_secret') setError('skills.brand.secret');
      else if (reason === 'tries_to_change_rules') setError('skills.brand.rules');
      else setError('errors.ipc.UNKNOWN');
    }
  };

  const limits: Record<Text, number> = {
    businessName: 80,
    about: 400,
    audience: 300,
    tone: 200,
    languages: 100,
    goals: 300,
    avoid: 300,
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      title={t.t('skills.brand.title')}
      size="md"
      initialFocusRef={firstRef}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setForm(EMPTY_BRAND);
              void save(EMPTY_BRAND);
            }}
          >
            {t.t('skills.brand.clear')}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t.t('confirmation.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save(form)}>
            {t.t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save(form);
        }}
      >
        <p className="text-small text-muted">{t.t('skills.brand.intro')}</p>
        {FIELDS.map(({ key, long }, index) => (
          <div key={key}>
            <label
              htmlFor={`${ids}-${key}`}
              className="mb-1.5 block text-small font-medium text-fg"
            >
              {t.t(`skills.brand.field.${key}` as TranslationKey)}
            </label>
            {long ? (
              <Textarea
                id={`${ids}-${key}`}
                autoGrow
                rows={2}
                maxRows={5}
                maxLength={limits[key]}
                value={form[key]}
                placeholder={t.t(`skills.brand.placeholder.${key}` as TranslationKey)}
                onChange={(event) => setForm({ ...form, [key]: event.target.value })}
              />
            ) : (
              <Input
                id={`${ids}-${key}`}
                ref={index === 0 ? firstRef : undefined}
                maxLength={limits[key]}
                value={form[key]}
                placeholder={t.t(`skills.brand.placeholder.${key}` as TranslationKey)}
                onChange={(event) => setForm({ ...form, [key]: event.target.value })}
              />
            )}
          </div>
        ))}
        <fieldset>
          <legend className="mb-1.5 text-small font-medium text-fg">
            {t.t('skills.brand.field.platforms')}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {SOCIAL_PLATFORMS.map((platform) => (
              <button
                key={platform}
                type="button"
                aria-pressed={form.platforms.includes(platform)}
                onClick={() => togglePlatform(platform)}
                className={cn(
                  'h-8 rounded-control border px-3 text-small font-medium transition-colors',
                  form.platforms.includes(platform)
                    ? 'border-accent bg-accent/15 text-accent-text'
                    : 'border-line text-muted hover:border-line-strong hover:text-fg',
                )}
              >
                {t.t(`skills.platform.${platform}` as TranslationKey)}
              </button>
            ))}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="text-small text-danger-text">
            {t.t(error)}
          </p>
        )}
      </form>
    </Modal>
  );
}
