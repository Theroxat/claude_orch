import './zodConfig';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import '@fontsource-variable/overpass';
import '@fontsource-variable/overpass-mono';
import './styles.css';
import { applyStoredTheme } from './ui/theme';
import { initLocale } from './i18n/index.ts';

applyStoredTheme();

const queryClient = new QueryClient();
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

// The non-English catalog is a lazy chunk: load it before the first paint so no English flashes.
void initLocale().then(() =>
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  ),
);
