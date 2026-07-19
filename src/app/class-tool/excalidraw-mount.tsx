// React bridge — the ONLY React code in the app.
//
// Excalidraw ships as a React component with no Angular equivalent, so
// we mount it imperatively into a DOM node handed to us by the Angular
// wrapper (see class-tool.component.ts). Every subsequent interaction
// (set read-only, apply a remote scene, subscribe to local changes for
// broadcast) is a plain function call on the ExcalidrawHandle returned
// below — Angular never touches JSX or React internals.

import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Excalidraw, getSceneVersion } from '@excalidraw/excalidraw';

// Pinning the concrete Excalidraw API type across minor version bumps
// is more churn than it's worth for internal-only use; typing as any
// keeps this file version-agnostic.
type ExcalidrawApi = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// Broadcast debounce — Excalidraw fires onChange on every pointer move.
// 150ms feels responsive to the peer while cutting typical drag-storms
// (~60 events/sec) to ~6 events/sec.
const BROADCAST_DEBOUNCE_MS = 150;

// ── Public handle ────────────────────────────────────────────────────
export interface ExcalidrawHandle {
  setReadOnly(readOnly: boolean): void;
  /** Apply a scene received from a peer. Echo-safe: we stamp the
   *  incoming scene version as "just applied" so the resulting
   *  onChange won't re-broadcast the same payload back. */
  applyRemoteScene(elements: readonly unknown[]): void;
  /** Register the broadcast callback for local edits. Debounced. */
  onLocalChange(cb: (elements: readonly unknown[]) => void): void;
  /** Snapshot of current scene. Used by the Share toggle so flipping
   *  Share ON pushes whatever the tutor already drew privately. */
  getSceneElements(): readonly unknown[];
  destroy(): void;
}

export interface MountOptions {
  isTutor: boolean;
}

// Hooks the React wrapper hands back to the mounter on first render.
// Everything the Angular side needs to poke is here.
interface WrapperHooks {
  setReadOnly: (v: boolean) => void;
  getApi: () => ExcalidrawApi | null;
  setLocalChangeCb: (cb: (elements: readonly unknown[]) => void) => void;
  /** Tells the wrapper "we're about to apply this version from remote,
   *  don't treat the resulting onChange as a local edit." */
  markVersionAsApplied: (v: number) => void;
}

interface WrapperProps {
  initialReadOnly: boolean;
  registerHooks: (h: WrapperHooks) => void;
}

const BoardWrapper: React.FC<WrapperProps> = ({ initialReadOnly, registerHooks }) => {
  const [readOnly, setReadOnly] = React.useState(initialReadOnly);

  // Refs are used deliberately so onChange closes over stable references
  // instead of stale state snapshots.
  const apiRef = React.useRef<ExcalidrawApi | null>(null);
  const lastSeenVersionRef = React.useRef<number>(-1);
  const localChangeCbRef = React.useRef<((elements: readonly unknown[]) => void) | null>(null);
  const debounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingElementsRef = React.useRef<readonly unknown[] | null>(null);
  // Set to true after the initial `setActiveTool(freedraw)` has run.
  // Excalidraw's excalidrawAPI callback fires on every internal
  // re-render (not just first mount). Without this guard, every re-
  // render was calling setActiveTool('freedraw') and stomping any
  // tool the user had just clicked — which looked like "the toolbar
  // stopped working".
  const initialToolSetRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    registerHooks({
      setReadOnly,
      getApi: () => apiRef.current,
      setLocalChangeCb: (cb) => { localChangeCbRef.current = cb; },
      markVersionAsApplied: (v) => { lastSeenVersionRef.current = v; },
    });
  }, [registerHooks]);

  // Clean up the pending broadcast timer on unmount so React doesn't
  // fire our callback into a torn-down tree.
  React.useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const handleChange = React.useCallback((elements: readonly unknown[]) => {
    // Two reasons to skip broadcast:
    //   1. Version didn't change → onChange fired for a UI-only reason
    //      (cursor move, selection). Nothing to send.
    //   2. Version equals what we just applied from remote →
    //      applyRemoteScene set lastSeenVersionRef before calling
    //      updateScene, so the resulting onChange lands here as a
    //      no-op. Prevents ping-pong.
    const version = getSceneVersion(elements as never);
    if (version === lastSeenVersionRef.current) return;
    lastSeenVersionRef.current = version;

    pendingElementsRef.current = elements;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      const els = pendingElementsRef.current;
      pendingElementsRef.current = null;
      debounceTimerRef.current = null;
      if (els && localChangeCbRef.current) localChangeCbRef.current(els);
    }, BROADCAST_DEBOUNCE_MS);
  }, []);

  return React.createElement(Excalidraw, {
    viewModeEnabled: readOnly,
    UIOptions: {
      canvasActions: {
        loadScene: false,
        saveToActiveFile: false,
      },
    },
    excalidrawAPI: (api: ExcalidrawApi) => {
      apiRef.current = api;
      // Default to the freedraw (pencil) tool for writers so they can
      // start drawing without hunting for the pen icon — but ONLY on
      // the very first API-ready fire. Excalidraw calls this callback
      // on every internal re-render; if we set the active tool every
      // time, we clobber whatever the user just clicked in the
      // toolbar. This is why "tools stop working after first use".
      if (!readOnly && api?.setActiveTool && !initialToolSetRef.current) {
        initialToolSetRef.current = true;
        try {
          api.setActiveTool({ type: 'freedraw' });
        } catch {
          // Older Excalidraw versions don't expose setActiveTool.
        }
      }
    },
    onChange: handleChange,
  });
};

// ── Public mount ─────────────────────────────────────────────────────
export function mountExcalidraw(container: HTMLElement, opts: MountOptions): ExcalidrawHandle {
  const root: Root = createRoot(container);

  // Excalidraw calibrates pointer→canvas coordinates against its
  // container's bounding rect at mount time. When the surrounding
  // layout later reflows (e.g. a peer joins, sidebar changes width)
  // Excalidraw doesn't re-measure on its own — pointer events start
  // landing in the wrong place.
  //
  // We ping it with a window resize event, BUT:
  //   1. Gated on actual size change ≥ 2px (ResizeObserver otherwise
  //      fires on subpixel drift, especially during CSS animations).
  //   2. Debounced ~250ms so we don't dispatch tens of times per
  //      second during a drag / animation.
  //
  // Both matter because a dispatched window resize triggers EVERY
  // resize listener in the app (Angular zone.js, PeerJS, WebRTC,
  // socket.io internals). Uncontrolled dispatches saturate the main
  // thread and starve the audio pipeline — the previous version
  // silently killed meeting audio the moment the whiteboard opened.
  let lastW = -1;
  let lastH = -1;
  let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
  const resizeObs = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (!rect) return;
    if (Math.abs(rect.width - lastW) < 2 && Math.abs(rect.height - lastH) < 2) {
      return;
    }
    lastW = rect.width;
    lastH = rect.height;
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      resizeDebounce = null;
      window.dispatchEvent(new Event('resize'));
    }, 250);
  });
  resizeObs.observe(container);

  // Wrapper hooks — populated once React finishes its first render.
  // Everything before that goes into pending* slots and is flushed
  // when registerHooks fires.
  let hooks: WrapperHooks | null = null;
  let pendingReadOnly: boolean | null = null;
  let pendingLocalChangeCb: ((elements: readonly unknown[]) => void) | null = null;
  let pendingRemoteScene: readonly unknown[] | null = null;

  const applyRemote = (elements: readonly unknown[]) => {
    if (!hooks) {
      pendingRemoteScene = elements;
      return;
    }
    // Stamp version BEFORE updateScene — the onChange that fires as a
    // result of updateScene will see it and skip broadcasting.
    hooks.markVersionAsApplied(getSceneVersion(elements as never));
    const api = hooks.getApi();
    if (api) api.updateScene({ elements });
  };

  const registerHooks: WrapperProps['registerHooks'] = (h) => {
    hooks = h;
    if (pendingReadOnly !== null) { h.setReadOnly(pendingReadOnly); pendingReadOnly = null; }
    if (pendingLocalChangeCb) { h.setLocalChangeCb(pendingLocalChangeCb); pendingLocalChangeCb = null; }
    if (pendingRemoteScene) { applyRemote(pendingRemoteScene); pendingRemoteScene = null; }
  };

  root.render(
    React.createElement(BoardWrapper, {
      initialReadOnly: !opts.isTutor,
      registerHooks,
    }),
  );

  return {
    setReadOnly(readOnly) {
      if (hooks) hooks.setReadOnly(readOnly);
      else pendingReadOnly = readOnly;
    },
    applyRemoteScene(elements) {
      applyRemote(elements);
    },
    onLocalChange(cb) {
      if (hooks) hooks.setLocalChangeCb(cb);
      else pendingLocalChangeCb = cb;
    },
    getSceneElements() {
      const api = hooks?.getApi();
      return api && typeof api.getSceneElements === 'function'
        ? api.getSceneElements()
        : [];
    },
    destroy() {
      // The wrapper's own cleanup effect clears any in-flight debounce
      // timer, so root.unmount() is enough on our side.
      resizeObs.disconnect();
      if (resizeDebounce) clearTimeout(resizeDebounce);
      root.unmount();
    },
  };
}
