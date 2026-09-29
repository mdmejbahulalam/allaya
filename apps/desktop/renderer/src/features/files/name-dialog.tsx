import { useRef, useState } from 'react';
import { useT } from '@renderer/lib/i18n';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Modal } from '@renderer/components/ui/modal';

/** Asks for one name (a new folder, or a new name for an item). The name is checked again by the file guard. */
export function NameDialog({
  open,
  title,
  label,
  confirmLabel,
  initialValue = '',
  busy,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  label: string;
  confirmLabel: string;
  initialValue?: string;
  busy?: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initialValue);
  const [wasOpen, setWasOpen] = useState(open);
  // Start from the proposed name each time the dialog opens (adjusting state while rendering, not in an effect).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(initialValue);
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const name = value.trim();
  const valid = name.length > 0 && !/[\\/]/.test(name);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      title={title}
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t.t('confirmation.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={busy}
            onClick={() => valid && onSubmit(name)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onSubmit(name);
        }}
      >
        <label className="mb-1.5 block text-small font-medium text-fg" htmlFor="file-name-input">
          {label}
        </label>
        <Input
          id="file-name-input"
          ref={inputRef}
          value={value}
          maxLength={255}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
        />
      </form>
    </Modal>
  );
}
