import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { installStyleNonce } from './lib/nonce';
import './styles.css';

// Before anything mounts: libraries that add <style> read the nonce when they first need it.
installStyleNonce();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
