import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DormChainProvider } from './context/DormChainContext';
import { ToastProvider } from './context/ToastContext';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <DormChainProvider>
        <App />
      </DormChainProvider>
    </ToastProvider>
  </StrictMode>,
);
