import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppInfo } from '@allaya/validation';
import './styles/index.css';

function Bootstrap() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.allaya.invoke('app:getInfo').then((result) => {
      if (result.ok) setInfo(result.data);
      else setError(result.error.code);
    });
  }, []);

  return (
    <main data-testid="bootstrap" style={{ padding: 32 }}>
      <h1>Allaya</h1>
      {info && (
        <p data-testid="version">
          v{info.version} · Electron {info.electronVersion}
        </p>
      )}
      {error && <p data-testid="error">{error}</p>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
);
