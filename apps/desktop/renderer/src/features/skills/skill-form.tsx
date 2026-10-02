import { useId, useRef, useState } from 'react';
import {
  MAX_SKILL_INSTRUCTION_CHARS,
  MAX_SKILL_KEYWORDS,
  MAX_SKILL_KEYWORD_CHARS,
  MAX_SKILL_NAME_CHARS,
  type CustomSkill,
} from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { Button } from '@renderer/components/ui/button';
import { Input, Textarea } from '@renderer/components/ui/input';
import { Modal } from '@renderer/components/ui/modal';

export interface SkillFormState {
  id?: string;
  name: string;
  instructions: string;
  /** Comma-separated, as typed. */
  keywords: string;
}

export const emptySkillForm = (): SkillFormState => ({ name: '', instructions: '', keywords: '' });
export const skillFormFrom = (skill: CustomSkill): SkillFormState => ({
  id: skill.id,
  name: skill.name,
  instructions: skill.instructions,
  keywords: skill.keywords.join(', '),
});

/** "poem, কবিতা ,, poem" → ["poem", "কবিতা"]: trimmed, no blanks, no repeats, within the limits. */
export function parseKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,،\n]/)) {
    const word = part.trim().slice(0, MAX_SKILL_KEYWORD_CHARS);
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out.slice(0, MAX_SKILL_KEYWORDS);
}

type Field = 'name' | 'instructions' | 'keywords';

/** Write or change a skill of your own. The backend checks everything again (secrets, rule-changing text). */
export function SkillForm({
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  /** The form as it starts; `null` while the dialog is closed. */
  initial: SkillFormState | null;
  busy: boolean;
  /** Rejects with the backend's error; the form shows it and stays open. */
  onSubmit: (skill: Omit<CustomSkill, 'id'> & { id?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const ids = useId();
  const [form, setForm] = useState<SkillFormState>(initial ?? emptySkillForm());
  const [errors, setErrors] = useState<Partial<Record<Field, TranslationKey>>>({});
  const [seed, setSeed] = useState(initial);
  if (initial !== seed) {
    setSeed(initial);
    if (initial) {
      setForm(initial);
      setErrors({});
    }
  }
  const nameRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof SkillFormState>(field: K, value: SkillFormState[K]) =>
    setForm((current) => ({ ...current, [field]: value }));

  const submit = async () => {
    const name = form.name.trim();
    const instructions = form.instructions.trim();
    const keywords = parseKeywords(form.keywords);
    const found: Partial<Record<Field, TranslationKey>> = {};
    if (!name) found.name = 'skills.form.needName';
    if (!instructions) found.instructions = 'skills.form.needInstructions';
    if (keywords.length === 0) found.keywords = 'skills.form.needKeywords';
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});
    try {
      await onSubmit({ ...(form.id ? { id: form.id } : {}), name, instructions, keywords });
    } catch (error) {
      const reason = error instanceof IpcError ? error.details?.['reason'] : undefined;
      if (reason === 'looks_secret') setErrors({ instructions: 'skills.form.secret' });
      else if (reason === 'tries_to_change_rules') setErrors({ instructions: 'skills.form.rules' });
      else if (reason === 'duplicate_name') setErrors({ name: 'skills.form.duplicate' });
      else if (reason === 'too_many') setErrors({ name: 'skills.form.tooMany' });
      else setErrors({ instructions: 'errors.ipc.UNKNOWN' });
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
      open={initial !== null}
      onOpenChange={(next) => !next && onCancel()}
      title={t.t(form.id ? 'skills.form.editTitle' : 'skills.form.newTitle')}
      size="md"
      initialFocusRef={nameRef}
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
        <p className="text-small text-muted">{t.t('skills.form.intro')}</p>
        <div>
          <label htmlFor={`${ids}-name`} className="mb-1.5 block text-small font-medium text-fg">
            {t.t('skills.form.name')}
          </label>
          <Input
            id={`${ids}-name`}
            ref={nameRef}
            value={form.name}
            maxLength={MAX_SKILL_NAME_CHARS}
            placeholder={t.t('skills.form.namePlaceholder')}
            invalid={Boolean(errors.name)}
            onChange={(event) => set('name', event.target.value)}
          />
          {fieldError('name')}
        </div>
        <div>
          <label htmlFor={`${ids}-text`} className="mb-1.5 block text-small font-medium text-fg">
            {t.t('skills.form.instructions')}
          </label>
          <Textarea
            id={`${ids}-text`}
            autoGrow
            rows={5}
            maxRows={12}
            maxLength={MAX_SKILL_INSTRUCTION_CHARS}
            value={form.instructions}
            placeholder={t.t('skills.form.instructionsPlaceholder')}
            invalid={Boolean(errors.instructions)}
            onChange={(event) => set('instructions', event.target.value)}
          />
          <p className="mt-1 text-caption text-muted">
            {t.t('skills.form.counter', {
              count: form.instructions.length,
              max: MAX_SKILL_INSTRUCTION_CHARS,
            })}
          </p>
          {fieldError('instructions')}
        </div>
        <div>
          <label htmlFor={`${ids}-words`} className="mb-1.5 block text-small font-medium text-fg">
            {t.t('skills.form.keywords')}
          </label>
          <Input
            id={`${ids}-words`}
            value={form.keywords}
            placeholder={t.t('skills.form.keywordsPlaceholder')}
            invalid={Boolean(errors.keywords)}
            onChange={(event) => set('keywords', event.target.value)}
          />
          <p className="mt-1 text-caption text-muted">{t.t('skills.form.keywordsHint')}</p>
          {fieldError('keywords')}
        </div>
      </form>
    </Modal>
  );
}
