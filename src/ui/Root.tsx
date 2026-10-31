import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { DialogProvider, ToastProvider } from './components/feedback';
import { usePrefs, useTheme, VaultProvider } from './lib/hooks';

function Themed({ children }: { children: ReactNode }) {
  const [prefs] = usePrefs();
  useTheme(prefs.theme);
  return <>{children}</>;
}

export function mount(node: ReactNode): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Themed>
        <ToastProvider>
          <DialogProvider>
            <VaultProvider>{node}</VaultProvider>
          </DialogProvider>
        </ToastProvider>
      </Themed>
    </StrictMode>,
  );
}
