import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';
import { Skeleton } from './skeleton';

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  width?: string;
  align?: 'start' | 'end';
  /** Hidden below the given container tier to keep narrow windows usable. */
  hideBelow?: 'md' | 'lg';
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  onRowClick,
  loading,
  empty,
  skeletonRows = 5,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Accessible table name. */
  caption: string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: ReactNode;
  skeletonRows?: number;
}) {
  const hide = (column: Column<T>) =>
    column.hideBelow === 'md'
      ? 'hidden md:table-cell'
      : column.hideBelow === 'lg'
        ? 'hidden lg:table-cell'
        : '';

  return (
    <div className="overflow-hidden rounded-card border border-line bg-card">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-body">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line bg-bg-2 text-start text-caption font-medium text-muted uppercase">
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  className={cn(
                    'px-4 py-2.5 font-medium',
                    column.align === 'end' ? 'text-end' : 'text-start',
                    hide(column),
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: skeletonRows }, (_, index) => (
                  <tr key={index} className="border-b border-line last:border-0">
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cn('px-4 py-[var(--row-pad-y)]', hide(column))}
                      >
                        <Skeleton className="h-4 w-3/4" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => (
                  <tr
                    key={rowKey(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      'border-b border-line last:border-0 transition-colors duration-150',
                      onRowClick && 'cursor-pointer hover:bg-elevated',
                    )}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cn(
                          'px-4 py-[var(--row-pad-y)] align-middle',
                          column.align === 'end' ? 'text-end' : 'text-start',
                          hide(column),
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && empty}
    </div>
  );
}
