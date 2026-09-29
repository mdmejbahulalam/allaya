import { Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return <Loader2 aria-hidden size={size} className={cn('animate-spin-slow', className)} />;
}
