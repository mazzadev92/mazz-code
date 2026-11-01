import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/sora';
import '@fontsource-variable/jetbrains-mono';
import 'katex/dist/katex.min.css';
import './styles/mazz-tokens.css';
import './styles/index.css';
import './contracts/anim.css';
import { AppShell } from './shell/AppShell';
import { startPolling, useApp } from './lib/store';
import { prefs } from './lib/prefs';
import type { StudioSettings } from './lib/types';

type Appearance = StudioSettings['appearance'];

/** Applies appearance settings to <html>; mirrored locally to avoid a flash on reload. */
function applyAppearance(a: Pick<Appearance, 'theme' | 'mode' | 'density' | 'uiScale' | 'motion' | 'highContrast' | 'codeFontSize'>): void {
  const root = document.documentElement;
  const mode = a.mode === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : a.mode;
  root.dataset.theme = a.theme;
  root.dataset.mode = mode;
  root.dataset.density = a.density;
  root.dataset.motion = a.motion;
  if (a.highContrast) root.dataset.contrast = 'high';
  else delete root.dataset.contrast;
  root.style.setProperty('--code-size', `${a.codeFontSize}px`);
  // CSS zoom scales the whole interface, including px-based sizes.
  (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = String(a.uiScale / 100);
}

const cached = prefs.get<Appearance | null>('appearance', null);
if (cached) applyAppearance(cached);

function Root() {
  const appearance = useApp((s) => s.settings?.appearance);
  const language = useApp((s) => s.settings?.general.language);
  useEffect(() => startPolling(), []);
  useEffect(() => {
    if (!appearance) return;
    applyAppearance(appearance);
    prefs.set('appearance', appearance);
    if (appearance.mode !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyAppearance(appearance);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [appearance]);
  useEffect(() => {
    if (language) document.documentElement.lang = language;
  }, [language]);
  return <AppShell />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
