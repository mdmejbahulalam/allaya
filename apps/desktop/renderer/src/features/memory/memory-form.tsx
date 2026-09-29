import { useId, useRef, useState } from 'react';
import { MEMORY_CATEGORIES, type MemoryCategory } from '@allaya/types';
import {
  MAX_MEMORY_KEY_CHARS,
  MAX_MEMORY_VALUE_CHARS,
  type MemoryInput,
  type MemoryView,
} from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { Button } from '@renderer/components/ui/button';
import { Input, Textarea } from '@renderer/components/ui/input';
import { Modal } from '@renderer/components/ui/modal';

const selectClass =
  'h-10 w-full rounded-control border border-line bg-bg-2 px-3 text-body text-fg hover:border-line-strong focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none';

export interface MemoryFormState {
  category: MemoryCategory;
  key: string;
  value: string;
}

export const emptyMemoryForm = (category: MemoryCategory = 'preferences'): MemoryFormState => ({
  category,
  key: '',
  value: '',
});

export const memoryFormFrom = (memory: MemoryView): MemoryFormState => ({
  category: memory.category,
  key: memory.key,
  value: memory.value,
});

type Field = 'key' | 'value';

/** Add or change a memory. The backend checks everything again (including for secrets); this only saves a trip. */
export function MemoryForm({
  initial,
  editing,
  busy,
  onSubmit,
  onCancel,
}: {
  /** The form as it starts; `null` while the dialog is closed. */
  initial: MemoryFormState | null;
  editing: boolean;
  busy: boolean;
  /** Rejects with the backend's error; the form shows it and stays open. */
  onSubmit: (input: MemoryInput) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const ids = useId();
  const open = initial !== null;
  const [form, setForm] = useState<MemoryFormState>(initial ?? emptyMemoryForm());
  const [errors, setErrors] = useState<Partial<Record<Field, TranslationKey>>>({});
  const [seed, setSeed] = useState(initial);
  // Start afresh each time the dialog opens (adjusting state while rendering, not in an effect).
  if (initial !== seed) {
    setSeed(initial);
    if (initial) {
      setForm(initial);
      setErrors({});
    }
  }
  const keyRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof MemoryFormState>(field: K, value: MemoryFormState[K]) =>
    setForm((current) => ({ ...current, [field]: value }));

  const submit = async () => {
    const key = form.key.trim();
    const value = form.value.trim();
    const found: Partial<Record<Field, TranslationKey>> = {};
    if (!key) found.key = 'memory.form.needKey';
    if (!value) found.value = 'memory.form.needValue';
    if (found.key || found.value) {
      setErrors(found);
      return;
    }
    setErrors({});
    try {
      await onSubmit({ category: form.category, key, value });
    } catch (error) {
      const reason = error instanceof IpcError ? error.details?.['reason'] : undefined;
      if (reason === 'looks_secret') setErrors({ value: 'memory.form.secret' });
      else if (reason === 'duplicate') setErrors({ key: 'memory.form.duplicate' });
      else setErrors({ value: 'errors.ipc.UNKNOWN' });
    }
  };

  const fieldError = (field: Field) =>
    errors[field] ? (
      <p role="alert" className="mt-1 text-small text-danger-text">
        {t.t(errors[field])}
      </p>
    ) : null;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      title={t.t(editing ? 'memory.edit' : 'memory.new')}
      size="md"
      initialFocusRef={keyRef}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t.t('confirmation.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
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
          void submit();
        }}
      >
        <div>
          <label htmlFor={`${ids}-cat`} className="mb-1.5 block text-small font-medium text-fg">
            {t.t('memory.form.category')}
          </label>
          <select
            id={`${ids}-cat`}
            className={selectClass}
            value={form.category}
            onChange={(event) => set('category', event.target.value as MemoryCategory)}
          >
            {MEMORY_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t.t(`memory.categories.${category}`)}
              </option>
            ))}
          </select>
          {form.category === 'instructions' && (
            <p className="mt-1 text-caption text-muted">{t.t('memory.form.instructionsHint')}</p>
          )}
        </div>

        <div>
          <label htmlFor={`${ids}-key`} className="mb-1.5 block text-small font-medium text-fg">
            {t.t('memory.form.key')}
          </label>
          <Input
            id={`${ids}-key`}
            ref={keyRef}
            value={form.key}
            maxLength={MAX_MEMORY_KEY_CHARS}
            placeholder={t.t('memory.form.keyPlaceholder')}
            invalid={Boolean(errors.key)}
            onChange={(event) => set('key', event.target.value)}
          />
          {fieldError('key')}
        </div>

        <div>
          <label htmlFor={`${ids}-value`} className="mb-1.5 block text-small font-medium text-fg">
            {t.t('memory.form.value')}
          </label>
          <Textarea
            id={`${ids}-value`}
            autoGrow
            rows={3}
            maxRows={8}
            maxLength={MAX_MEMORY_VALUE_CHARS}
            value={form.value}
            placeholder={t.t('memory.form.valuePlaceholder')}
            invalid={Boolean(errors.value)}
            onChange={(event) => set('value', event.target.value)}
          />
          {fieldError('value')}
        </div>
      </form>
    </Modal>
  );
}
