import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import { installStyleNonce } from './lib/nonce';
import './styles/index.css';

// Must run before any component mounts: libraries that inject <style> read the nonce lazily.
installStyleNonce();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
