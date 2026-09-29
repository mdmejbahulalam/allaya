import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useT } from '@renderer/lib/i18n';
import { Button } from '@renderer/components/ui/button';
import { EmptyState } from '@renderer/components/ui/empty-state';

function Fallback({ error, reset }: { error: Error; reset: () => void }) {
  const t = useT();
  return (
    <div role="alert">
      <EmptyState
        icon={TriangleAlert}
        title={t.t('errors.boundaryTitle')}
        description={t.t('errors.boundaryBody')}
        action={
          <div className="flex flex-col items-center gap-3">
            <Button variant="primary" onClick={reset}>
              {t.t('errors.tryAgain')}
            </Button>
            <details className="max-w-md text-start text-small text-muted">
              <summary className="cursor-pointer text-center">
                {t.t('common.technicalDetails')}
              </summary>
              <pre className="mt-2 rounded-lg bg-bg-2 p-3 font-mono text-caption break-words whitespace-pre-wrap">
                {error.message}
              </pre>
            </details>
          </div>
        }
      />
    </div>
  );
}

/** Contains a crash to one screen; the rest of the app keeps running. */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Renderer has no logger sink; main receives renderer failures via the render-process-gone hook.
    void error;
    void info;
  }

  override componentDidUpdate(previous: { resetKey?: string }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey)
      this.setState({ error: null });
  }

  override render() {
    if (this.state.error)
      return <Fallback error={this.state.error} reset={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
