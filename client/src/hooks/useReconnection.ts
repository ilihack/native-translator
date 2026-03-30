/**
 * Manages WebSocket reconnection scheduling with a single-timer guarantee.
 * All retry sources (online restore, device change, WebSocket close) funnel
 * through scheduleRetry() so only one pending timer can exist at any time.
 * @inputs Refs shared with useLiveSession for session start and guard flags
 * @exports useReconnection hook returning retry refs and the scheduleRetry callback
 */
import { useRef, useCallback, MutableRefObject } from 'react';
import { logger } from '../utils/logger';

/** How often (ms) the retry poller re-checks guard flags before executing. */
const RETRY_POLL_INTERVAL = 500;

interface UseReconnectionParams {
  /** Ref to the current startSession function — called when retry fires. */
  startSessionRef: MutableRefObject<(() => Promise<void>) | null>;
  /** Guard: true while a session start/stop operation is in-flight. */
  pendingOperationRef: MutableRefObject<boolean>;
  /** Guard: true while cleanupSession teardown is running. */
  teardownInProgressRef: MutableRefObject<boolean>;
}

interface UseReconnectionReturn {
  /** Number of consecutive reconnect attempts since last successful connect. */
  reconnectAttemptRef: MutableRefObject<number>;
  /** Handle of the single pending retry timer, or null when idle. */
  reconnectTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  /** When false, scheduleRetry silently cancels (user stopped manually). */
  shouldAutoReconnectRef: MutableRefObject<boolean>;
  /** Schedule a single retry attempt after delayMs, replacing any existing timer. */
  scheduleRetry: (delayMs: number, source: string) => void;
}

export function useReconnection({
  startSessionRef,
  pendingOperationRef,
  teardownInProgressRef,
}: UseReconnectionParams): UseReconnectionReturn {
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldAutoReconnectRef = useRef<boolean>(true);

  const scheduleRetry = useCallback((delayMs: number, source: string) => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
      logger.session.debug('Cleared existing retry timer', { source });
    }

    logger.session.info('Scheduling retry', { source, delayMs });

    const attemptRetry = () => {
      if (!shouldAutoReconnectRef.current || document.hidden) {
        logger.session.debug('Retry cancelled - not recoverable', {
          source,
          autoReconnect: shouldAutoReconnectRef.current,
          hidden: document.hidden,
        });
        reconnectTimeoutRef.current = null;
        return;
      }

      if (pendingOperationRef.current || teardownInProgressRef.current) {
        logger.session.debug('Retry deferred - operation/teardown pending, polling again', {
          source,
          pending: pendingOperationRef.current,
          teardown: teardownInProgressRef.current,
        });
        reconnectTimeoutRef.current = setTimeout(attemptRetry, RETRY_POLL_INTERVAL);
        return;
      }

      reconnectTimeoutRef.current = null;
      logger.session.info('Executing scheduled retry', { source });
      // startSession returns a Promise — catch any rejection so it doesn't
      // surface as an unhandled promise rejection in the browser console.
      startSessionRef.current?.().catch(e => {
        logger.session.error('Scheduled retry threw unexpectedly', e);
      });
    };

    reconnectTimeoutRef.current = setTimeout(attemptRetry, delayMs);
  }, []);

  return { reconnectAttemptRef, reconnectTimeoutRef, shouldAutoReconnectRef, scheduleRetry };
}
