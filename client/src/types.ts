/**
 * Shared TypeScript type definitions for the interpreter app: session states,
 * events, connection status enum, and session context interface.
 * @exports ConnectionStatus, SessionState, SessionEvent, SessionContext, TextType
 */

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export enum SessionState {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  LISTENING = 'LISTENING',
  SPEAKING = 'SPEAKING',
  DISCONNECTING = 'DISCONNECTING',
  ERROR = 'ERROR'
}

export type SessionEvent =
  | { type: 'START_REQUESTED' }
  | { type: 'START_SUCCEEDED' }
  | { type: 'START_FAILED'; error?: string }
  | { type: 'MODEL_AUDIO_STARTED' }
  | { type: 'MODEL_AUDIO_ENDED' }
  | { type: 'TURN_COMPLETE' }
  | { type: 'INTERRUPTED' }
  | { type: 'STOP_REQUESTED' }
  | { type: 'STOP_CONFIRMED' }
  | { type: 'NETWORK_ERROR'; error?: string }
  | { type: 'TIMEOUT' }
  | { type: 'HARD_RESET' }
  | { type: 'UPDATE_TEXT'; topText?: string; bottomText?: string; textType?: 'input' | 'output' }
  | { type: 'SET_TEXT'; topText: string; bottomText: string; textType?: 'input' | 'output' }
  | { type: 'UPDATE_LATENCY'; latency: number }
  | { type: 'CLEAR_TEXT' }
  | { type: 'CONNECTION_QUALITY_DEGRADED' }
  | { type: 'CONNECTION_QUALITY_RECOVERED' };

export type TextType = 'input' | 'output' | null;

export interface SessionContext {
  state: SessionState;
  topText: string;
  bottomText: string;
  latency: number;
  processingTime: number;
  hasInteracted: boolean;
  isTurnFinished: boolean;
  errorMessage?: string;
  lastTextType: TextType;
  isConnectionDegraded: boolean;
  // Track degradation sources separately to avoid conflicts
  isPlayerDegraded: boolean;  // Audio buffer underrun / grace period
  isLatencyDegraded: boolean; // High RTT latency > 1500ms
}
