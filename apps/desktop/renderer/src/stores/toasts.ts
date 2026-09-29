import { create } from 'zustand';
import type { NotificationKind } from '@allaya/types';

export interface ToastItem {
  id: number;
  kind: NotificationKind;
  message: string;
  description?: string;
  /** ms; 0 keeps it until dismissed (used for `working` and errors). */
  duration: number;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, 'id' | 'duration'> & { duration?: number }) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let nextId = 1;
const defaultDuration: Record<NotificationKind, number> = {
  success: 4000,
  info: 5000,
  working: 0,
  warning: 7000,
  error: 0,
};

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push(toast) {
    const id = nextId++;
    const item: ToastItem = {
      ...toast,
      id,
      duration: toast.duration ?? defaultDuration[toast.kind],
    };
    set((state) => ({ toasts: [...state.toasts.slice(-4), item] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

type Options = Pick<ToastItem, 'description' | 'actionLabel' | 'onAction'> & { duration?: number };
const make =
  (kind: NotificationKind) =>
  (message: string, options: Options = {}) =>
    useToastStore.getState().push({ kind, message, ...options });

/** Imperative API usable from anywhere (event handlers, IPC listeners). */
export const toast = {
  success: make('success'),
  info: make('info'),
  working: make('working'),
  warning: make('warning'),
  error: make('error'),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
};
