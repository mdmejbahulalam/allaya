import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ConversationView } from '@allaya/validation';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { Button } from '@renderer/components/ui/button';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Input } from '@renderer/components/ui/input';

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  conversations: ConversationView[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (conversation: ConversationView) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commit = (id: string) => {
    const title = draft.trim();
    if (title) onRename(id, title);
    setEditing(null);
  };

  return (
    <nav aria-label={t.t('chat.conversationsList')} className="flex h-full flex-col">
      <div className="p-3">
        <Button
          variant="secondary"
          className="w-full"
          leftIcon={<MessageSquarePlus size={16} />}
          onClick={onNew}
        >
          {t.t('chat.newConversation')}
        </Button>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {conversations.length === 0 && (
          <li className="px-3 py-6 text-center text-small text-muted">
            {t.t('chat.noConversations')}
          </li>
        )}
        {conversations.map((c) => (
          <li key={c.id} className="group relative">
            {editing === c.id ? (
              <Input
                autoFocus
                aria-label={t.t('chat.renameConversation')}
                value={draft}
                maxLength={120}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => commit(c.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit(c.id);
                  else if (event.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  aria-current={c.id === activeId ? 'true' : undefined}
                  onClick={() => onSelect(c.id)}
                  onDoubleClick={() => {
                    setDraft(c.title);
                    setEditing(c.id);
                  }}
                  className={cn(
                    'block w-full truncate rounded-control py-2 ps-3 pe-16 text-start text-body transition-colors duration-150',
                    c.id === activeId
                      ? 'bg-elevated font-medium text-fg'
                      : 'text-muted hover:bg-elevated/60 hover:text-fg',
                  )}
                >
                  {c.title}
                </button>
                <span className="absolute end-1 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton
                    size="sm"
                    label={t.t('chat.renameConversation')}
                    icon={<Pencil size={14} />}
                    onClick={() => {
                      setDraft(c.title);
                      setEditing(c.id);
                    }}
                  />
                  <IconButton
                    size="sm"
                    label={t.t('chat.deleteConversation')}
                    icon={<Trash2 size={14} />}
                    onClick={() => onDelete(c)}
                  />
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
