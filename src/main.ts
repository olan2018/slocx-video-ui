import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';

// Runtime `process` shim for React / Excalidraw.
//
// React and its ecosystem (Excalidraw included) ship bundles that
// reference `process.env.NODE_ENV` at runtime, expecting a bundler
// (CRA, Next, Vite, plain webpack with DefinePlugin) to replace those
// refs with string literals at build time. Angular's builder does not
// do that replacement, so the shipped code throws
// `ReferenceError: process is not defined` the first time the lazy
// Excalidraw chunk executes.
//
// The shim below is the minimum surface those libraries touch. It
// must run BEFORE bootstrap so any downstream `import()` sees it.
// Setting NODE_ENV to 'production' keeps React in its faster prod
// mode inside the meeting UI.
(window as unknown as { process?: unknown }).process =
  (window as unknown as { process?: unknown }).process ||
  { env: { NODE_ENV: 'production' } };


platformBrowserDynamic().bootstrapModule(AppModule)
  .catch(err => console.error(err));
