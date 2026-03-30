/**
 * Toast notification component that detects when a new service worker version
 * is available and prompts the user to refresh for the latest update.
 * Update notifications are persistent — they never auto-dismiss — because
 * a missed auto-dismiss means the user is stuck on an old version indefinitely.
 * @inputs None (listens to navigator.serviceWorker registration events)
 * @exports ServiceWorkerUpdateToast component
 */
import { useEffect, useRef, useState } from 'react';

export function ServiceWorkerUpdateToast() {
  const workerRef = useRef<ServiceWorker | null>(null);
  const hasShownToastRef = useRef(false);
  const [showNotification, setShowNotification] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  const handleUpdate = () => {
    if (!workerRef.current) return;
    setIsApplying(true);

    const onControllerChange = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    workerRef.current.postMessage({ action: 'SKIP_WAITING' });

    // Fallback: reload after 3s if controllerchange never fires
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      window.location.reload();
    }, 3000);
  };

  const handleDismiss = () => {
    // User explicitly dismisses — hide the toast but do NOT clear hasShownToastRef
    // so it re-appears on the next visibility/focus event via the registration.update() cycle
    setShowNotification(false);
  };

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const showUpdateNotification = (worker: ServiceWorker) => {
      if (hasShownToastRef.current) return;
      hasShownToastRef.current = true;
      workerRef.current = worker;
      setShowNotification(true);
      // No auto-dismiss timeout — update must reach the user
    };

    navigator.serviceWorker.ready.then((registration) => {
      // Check for a SW already waiting from a previous visit
      if (registration.waiting) {
        showUpdateNotification(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateNotification(newWorker);
          }
        });
      });
    });

    // Re-show toast on visibility regain if a waiting SW was dismissed
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && workerRef.current && !showNotification) {
        hasShownToastRef.current = false;
        setShowNotification(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [showNotification]);

  if (!showNotification) return null;

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 bottom-28 z-50 animate-in fade-in slide-in-from-bottom-2 duration-300"
      data-testid="notification-update-available"
      role="status"
      aria-live="polite"
      aria-label="App update available"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/98 border border-green-500/40 rounded-xl text-xs text-zinc-200 backdrop-blur-sm shadow-xl shadow-black/40">
        {/* Icon */}
        <svg className="w-3.5 h-3.5 text-green-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>

        {/* Message */}
        <span className="text-zinc-300">Update available</span>

        {/* Update CTA */}
        <button
          onClick={handleUpdate}
          disabled={isApplying}
          data-testid="button-update-start"
          aria-label="Apply update and reload"
          className="ml-1 px-2 py-0.5 bg-green-600 hover:bg-green-500 disabled:opacity-60 text-white text-[11px] font-medium rounded-md transition-colors"
        >
          {isApplying ? 'Updating…' : 'Update'}
        </button>

        {/* Dismiss */}
        <button
          onClick={handleDismiss}
          data-testid="button-update-dismiss"
          aria-label="Dismiss update notification"
          className="ml-0.5 p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
