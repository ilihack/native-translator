/**
 * Finite state machine hook managing session states (IDLE → CONNECTING → LISTENING → SPEAKING)
 * with typed transitions, latency tracking, and error context propagation.
 * @inputs SessionEvent dispatches (CONNECT, CONNECTED, AUDIO_START, ERROR, etc.)
 * @exports useSessionMachine hook returning current state, context, and dispatch function
 */
import { useReducer, useCallback } from 'react';
import { SessionState, SessionEvent, SessionContext } from '../types';
import { logger } from '../utils/logger';

const HIGH_LATENCY_THRESHOLD = 1500; // Warn when latency > 1500ms
const LATENCY_RECOVERY_THRESHOLD = 1000; // Clear warning when latency < 1000ms (hysteresis)

const initialContext: SessionContext = {
  state: SessionState.IDLE,
  topText: '',
  bottomText: '',
  latency: 0,
  processingTime: 0,
  hasInteracted: false,
  isTurnFinished: false,
  errorMessage: undefined,
  lastTextType: null,
  isConnectionDegraded: false,
  isPlayerDegraded: false,
  isLatencyDegraded: false
};

function sessionReducer(context: SessionContext, event: SessionEvent): SessionContext {
  const { state } = context;
  const prevState = state;
  let nextContext: SessionContext = context;
  
  switch (event.type) {
    case 'START_REQUESTED':
      if (state === SessionState.IDLE || state === SessionState.ERROR) {
        nextContext = {
          ...context,
          state: SessionState.CONNECTING,
          hasInteracted: true,
          isTurnFinished: false,
          errorMessage: undefined,
          topText: '',
          bottomText: '',
          latency: 0,
          lastTextType: null,
          isConnectionDegraded: false,
          isPlayerDegraded: false,
          isLatencyDegraded: false,
        };
      } else if (state === SessionState.LISTENING || state === SessionState.SPEAKING) {
        nextContext = { ...context, state: SessionState.DISCONNECTING };
      }
      break;

    case 'START_SUCCEEDED':
      if (state === SessionState.CONNECTING) {
        nextContext = { ...context, state: SessionState.LISTENING, isTurnFinished: true };
      }
      break;

    case 'START_FAILED':
      if (state === SessionState.CONNECTING) {
        nextContext = { 
          ...context, 
          state: SessionState.ERROR, 
          errorMessage: event.error || 'Connection failed'
        };
      }
      break;

    case 'MODEL_AUDIO_STARTED':
      if (state === SessionState.LISTENING) {
        nextContext = { ...context, state: SessionState.SPEAKING, isTurnFinished: false };
      }
      break;

    case 'MODEL_AUDIO_ENDED':
      if (state === SessionState.SPEAKING) {
        nextContext = { ...context, state: SessionState.LISTENING };
      }
      break;

    case 'TURN_COMPLETE':
      nextContext = { ...context, isTurnFinished: true };
      break;

    case 'INTERRUPTED':
      // Guard: only valid from SPEAKING or LISTENING.
      // If the state is DISCONNECTING (user pressed Stop while AI was mid-turn),
      // a server-sent "interrupted" message can arrive before the WebSocket closes.
      // Without this guard the machine would jump DISCONNECTING → LISTENING, leaving
      // the subsequent STOP_CONFIRMED event unmatched (it only fires from DISCONNECTING)
      // and the session stuck in a LISTENING state with all audio resources torn down.
      if (state === SessionState.SPEAKING || state === SessionState.LISTENING) {
        nextContext = {
          ...context,
          state: SessionState.LISTENING,
          topText: '',
          bottomText: '',
          isTurnFinished: true
        };
      }
      break;

    case 'STOP_REQUESTED':
      if (state === SessionState.LISTENING || state === SessionState.SPEAKING || state === SessionState.CONNECTING) {
        nextContext = { ...context, state: SessionState.DISCONNECTING };
      }
      break;

    case 'STOP_CONFIRMED':
      if (state === SessionState.DISCONNECTING) {
        nextContext = { ...context, state: SessionState.IDLE, isTurnFinished: false, isConnectionDegraded: false };
      }
      break;

    case 'NETWORK_ERROR':
      nextContext = { 
        ...context, 
        state: SessionState.ERROR, 
        errorMessage: event.error || 'Network error'
      };
      break;

    case 'TIMEOUT':
      nextContext = { ...context, state: SessionState.IDLE, hasInteracted: false };
      break;

    case 'HARD_RESET':
      nextContext = { ...initialContext, isConnectionDegraded: false, isPlayerDegraded: false, isLatencyDegraded: false };
      break;

    case 'UPDATE_TEXT':
      nextContext = {
        ...context,
        topText: event.topText !== undefined ? context.topText + event.topText : context.topText,
        bottomText: event.bottomText !== undefined ? context.bottomText + event.bottomText : context.bottomText,
        isTurnFinished: false,
        lastTextType: event.textType ?? context.lastTextType
      };
      break;

    case 'SET_TEXT':
      nextContext = {
        ...context,
        topText: event.topText,
        bottomText: event.bottomText,
        isTurnFinished: false,
        lastTextType: event.textType ?? context.lastTextType
      };
      break;

    case 'UPDATE_LATENCY': {
      const alpha = 0.3;
      const prevLatency = context.latency;
      const newLatency = prevLatency === 0 
        ? event.latency 
        : Math.round(alpha * event.latency + (1 - alpha) * prevLatency);
      
      // Check if latency crosses threshold (with hysteresis)
      let isLatencyDegraded = context.isLatencyDegraded;
      if (newLatency > HIGH_LATENCY_THRESHOLD && !context.isLatencyDegraded) {
        isLatencyDegraded = true;
        logger.network.warn('High latency detected', { latency: newLatency, threshold: HIGH_LATENCY_THRESHOLD });
      } else if (newLatency < LATENCY_RECOVERY_THRESHOLD && context.isLatencyDegraded) {
        isLatencyDegraded = false;
        logger.network.info('Latency recovered', { latency: newLatency, threshold: LATENCY_RECOVERY_THRESHOLD });
      }
      
      // Combined degradation state: either player or latency issue
      const isConnectionDegraded = context.isPlayerDegraded || isLatencyDegraded;
      
      nextContext = { ...context, latency: newLatency, isLatencyDegraded, isConnectionDegraded };
      break;
    }

    case 'CLEAR_TEXT':
      nextContext = { ...context, topText: '', bottomText: '', lastTextType: null };
      break;

    case 'CONNECTION_QUALITY_DEGRADED':
      // Player is degraded (audio buffer underrun / grace period)
      nextContext = { 
        ...context, 
        isPlayerDegraded: true, 
        isConnectionDegraded: true  // Combined state for UI
      };
      break;

    case 'CONNECTION_QUALITY_RECOVERED':
      // Player recovered - but check if latency is still high
      nextContext = { 
        ...context, 
        isPlayerDegraded: false,
        isConnectionDegraded: context.isLatencyDegraded  // Keep degraded if latency is still high
      };
      break;

    default:
      break;
  }
  
  if (nextContext.state !== prevState) {
    logger.state.info('State transition', {
      from: prevState,
      to: nextContext.state,
      event: event.type,
      hasError: !!nextContext.errorMessage
    });
  } else if (event.type !== 'UPDATE_TEXT' && event.type !== 'UPDATE_LATENCY' && event.type !== 'SET_TEXT') {
    logger.state.debug('Event processed', { 
      event: event.type, 
      state: nextContext.state 
    });
  }
  
  return nextContext;
}

export function useSessionMachine() {
  const [context, dispatch] = useReducer(sessionReducer, initialContext);

  const send = useCallback((event: SessionEvent) => {
    dispatch(event);
  }, []);

  const canStart = context.state === SessionState.IDLE || context.state === SessionState.ERROR;
  const canStop = context.state === SessionState.LISTENING || 
                  context.state === SessionState.SPEAKING || 
                  context.state === SessionState.CONNECTING;
  const isConnected = context.state === SessionState.LISTENING || context.state === SessionState.SPEAKING;
  const isSpeaking = context.state === SessionState.SPEAKING;
  const isConnectionDegraded = context.isConnectionDegraded;

  return {
    context,
    send,
    canStart,
    canStop,
    isConnected,
    isSpeaking,
    isConnectionDegraded
  };
}
