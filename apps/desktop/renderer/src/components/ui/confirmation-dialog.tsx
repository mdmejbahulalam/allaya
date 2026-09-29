import { ShieldAlert, TriangleAlert } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import type { RiskLevel } from '@allaya/types';
import { useT } from '@renderer/lib/i18n';
import { Badge } from './badge';
import { Button } from './button';
import { Modal } from './modal';

export interface ConfirmationDialogProps {
  open: boolean;
  /** One line describing exactly what Allaya wants to do, e.g. "Allaya wants to delete 17 files." */
  message: string;
  risk: RiskLevel;
  /** Concrete target, e.g. "Downloads/Old Files". */
  location?: string;
  /** Optional extra context (file list preview, etc). */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  onReview?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Label for the optional third action (defaults to "Review files"). */
  reviewLabel?: string;
}

/**
 * High-risk actions require an explicit decision. Safe defaults: focus starts on Cancel,
 * Escape and overlay-click cancel, and only the Confirm button proceeds.
 */
export function ConfirmationDialog({
  open,
  message,
  risk,
  location,
  children,
  onConfirm,
  onCancel,
  onReview,
  confirmLabel,
  cancelLabel,
  reviewLabel,
}: ConfirmationDialogProps) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const destructive = risk === 'HIGH' || risk === 'CRITICAL';

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      title={t.t('confirmation.title')}
      description={message}
      size="sm"
      initialFocusRef={cancelRef}
      icon={
        <span
          className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl ${destructive ? 'bg-danger/15 text-danger-text' : 'bg-warning/15 text-warning'}`}
        >
          {destructive ? (
            <ShieldAlert aria-hidden size={20} />
          ) : (
            <TriangleAlert aria-hidden size={20} />
          )}
        </span>
      }
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            {cancelLabel ?? t.t('confirmation.cancel')}
          </Button>
          {onReview && (
            <Button variant="outline" onClick={onReview}>
              {reviewLabel ?? t.t('confirmation.review')}
            </Button>
          )}
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel ?? t.t('confirmation.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-body">
        <Badge
          tone={
            risk === 'CRITICAL' || risk === 'HIGH'
              ? 'danger'
              : risk === 'MEDIUM'
                ? 'warning'
                : 'success'
          }
          dot
        >
          {t.t(`risk.${risk}`)}
        </Badge>
        {location && (
          <div>
            <div className="text-caption text-muted">{t.t('confirmation.location')}</div>
            <div className="font-mono text-small break-all text-fg">{location}</div>
          </div>
        )}
        {children}
        {destructive && <p className="text-small text-muted">{t.t('confirmation.irreversible')}</p>}
      </div>
    </Modal>
  );
}
