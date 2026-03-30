/// <reference types="vite/client" />
/**
 * Structured logging system with categorized levels (debug/info/warn/error),
 * ring-buffer history, and performance timing utilities for audio/session diagnostics.
 * @inputs Log messages with category tags (audio, session, transport, etc.)
 * @exports logger singleton with category-scoped methods and getLogHistory()
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogCategory = 'audio' | 'session' | 'transport' | 'ui' | 'general' | 'performance' | 'network' | 'state';

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: unknown;
}

// Reduced to 600 entries (~150KB) for reliable Android clipboard copy
// Android clipboard limit is ~1MB, this leaves headroom for JSON payloads
const LOG_BUFFER_SIZE = 600;
const logBuffer: LogEntry[] = [];

/**
 * Safe localStorage read — returns null instead of throwing in Firefox Private Mode
 * or other environments where localStorage access is blocked (SecurityError).
 */
function safeLocalStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/**
 * Safe localStorage write — silently ignores storage errors (quota, private mode).
 */
function safeLocalStorageRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* blocked */ }
}

function safeLocalStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* blocked or quota */ }
}

let isLoggingEnabled = safeLocalStorageGet('logging_enabled') === 'true';
// Object.create(null) produces a prototype-less map: no __proto__, constructor, or
// toString keys exist on it, so arbitrary string keys can never pollute Object.prototype.
const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

// ── Previous-session log persistence ────────────────────────────────────────
// On startup we read whatever the last session wrote to localStorage, keep it
// for the "Letzte Sitzung" copy button, then clear the key so the new session
// starts fresh.  The key is written every 3 s and on beforeunload so crashes
// and tab-kills both preserve the last known log state.
const BACKUP_KEY = 'session_logs_backup';
const BACKUP_MAX_BYTES = 150_000; // stay well under localStorage limits

// Read and clear the previous session snapshot (raw formatted text)
let previousSessionLogStr: string | null = null;
const _savedRaw = safeLocalStorageGet(BACKUP_KEY);
if (_savedRaw) {
  previousSessionLogStr = _savedRaw;
  safeLocalStorageRemove(BACKUP_KEY);
}

/** Persist current logBuffer to localStorage (trimmed to BACKUP_MAX_BYTES). */
function flushLogsToStorage(): void {
  if (!isLoggingEnabled || logBuffer.length === 0) return;
  // Build a compact text snapshot (same format as exportLogs, no redaction needed here
  // because it stays on-device — we still redact on manual export/copy).
  const lines: string[] = [];
  let totalBytes = 0;
  for (let i = logBuffer.length - 1; i >= 0; i--) {
    const e = logBuffer[i];
    let line = `[${formatTime(e.timestamp)}] [${e.level.toUpperCase()}] [${e.category}] ${e.message}`;
    if (e.data !== undefined) {
      const d = JSON.stringify(e.data);
      line += ` | ${d.length > 300 ? d.slice(0, 300) + '…' : d}`;
    }
    totalBytes += line.length + 1;
    if (totalBytes > BACKUP_MAX_BYTES) break;
    lines.unshift(line);
  }
  safeLocalStorageSet(BACKUP_KEY, lines.join('\n'));
}

// Flush every 3 seconds while the page is open
setInterval(flushLogsToStorage, 3_000);

// Flush on page unload / crash-close so the very last entries are captured
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushLogsToStorage);
  // 'pagehide' fires on mobile when tab is sent to background before kill
  window.addEventListener('pagehide', flushLogsToStorage);
}
// ────────────────────────────────────────────────────────────────────────────

const levelColors: Record<LogLevel, string> = {
  debug: '#888',
  info: '#4a9eff',
  warn: '#ffaa00',
  error: '#ff4444'
};

const categoryEmoji: Record<LogCategory, string> = {
  audio: '🎵',
  session: '🔌',
  transport: '📡',
  ui: '🖥️',
  general: '📝',
  performance: '⚡',
  network: '🌐',
  state: '🔄'
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

function log(level: LogLevel, category: LogCategory, message: string, data?: unknown) {
  if (!isLoggingEnabled) return;
  
  const entry: LogEntry = {
    timestamp: Date.now(),
    level,
    category,
    message,
    data
  };
  
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }

  // Flush to localStorage immediately on error or warn so that even if the
  // page crashes right after, the relevant entries are already persisted.
  // (Normal entries are flushed on the 3-second interval.)
  if (level === 'error' || level === 'warn') {
    flushLogsToStorage();
  }

  const time = formatTime(entry.timestamp);
  const emoji = categoryEmoji[category];
  const color = levelColors[level];
  
  const prefix = `%c[${time}] ${emoji} [${category.toUpperCase()}]`;
  const style = `color: ${color}; font-weight: ${level === 'error' ? 'bold' : 'normal'}`;
  
  if (data !== undefined) {
    if (level === 'error') console.error(prefix, style, message, data);
    else if (level === 'warn') console.warn(prefix, style, message, data);
    else if (level === 'info') console.info(prefix, style, message, data);
    else console.log(prefix, style, message, data);
  } else {
    if (level === 'error') console.error(prefix, style, message);
    else if (level === 'warn') console.warn(prefix, style, message);
    else if (level === 'info') console.info(prefix, style, message);
    else console.log(prefix, style, message);
  }
}

export const logger = {
  debug: (category: LogCategory, message: string, data?: unknown) => log('debug', category, message, data),
  info: (category: LogCategory, message: string, data?: unknown) => log('info', category, message, data),
  warn: (category: LogCategory, message: string, data?: unknown) => log('warn', category, message, data),
  error: (category: LogCategory, message: string, data?: unknown) => log('error', category, message, data),
  
  audio: {
    debug: (message: string, data?: unknown) => log('debug', 'audio', message, data),
    info: (message: string, data?: unknown) => log('info', 'audio', message, data),
    warn: (message: string, data?: unknown) => log('warn', 'audio', message, data),
    error: (message: string, data?: unknown) => log('error', 'audio', message, data),
  },
  
  session: {
    debug: (message: string, data?: unknown) => log('debug', 'session', message, data),
    info: (message: string, data?: unknown) => log('info', 'session', message, data),
    warn: (message: string, data?: unknown) => log('warn', 'session', message, data),
    error: (message: string, data?: unknown) => log('error', 'session', message, data),
  },
  
  transport: {
    debug: (message: string, data?: unknown) => log('debug', 'transport', message, data),
    info: (message: string, data?: unknown) => log('info', 'transport', message, data),
    warn: (message: string, data?: unknown) => log('warn', 'transport', message, data),
    error: (message: string, data?: unknown) => log('error', 'transport', message, data),
  },
  
  ui: {
    debug: (message: string, data?: unknown) => log('debug', 'ui', message, data),
    info: (message: string, data?: unknown) => log('info', 'ui', message, data),
    warn: (message: string, data?: unknown) => log('warn', 'ui', message, data),
    error: (message: string, data?: unknown) => log('error', 'ui', message, data),
  },
  
  general: {
    debug: (message: string, data?: unknown) => log('debug', 'general', message, data),
    info: (message: string, data?: unknown) => log('info', 'general', message, data),
    warn: (message: string, data?: unknown) => log('warn', 'general', message, data),
    error: (message: string, data?: unknown) => log('error', 'general', message, data),
  },
  
  performance: {
    debug: (message: string, data?: unknown) => log('debug', 'performance', message, data),
    info: (message: string, data?: unknown) => log('info', 'performance', message, data),
    warn: (message: string, data?: unknown) => log('warn', 'performance', message, data),
    error: (message: string, data?: unknown) => log('error', 'performance', message, data),
  },
  
  network: {
    debug: (message: string, data?: unknown) => log('debug', 'network', message, data),
    info: (message: string, data?: unknown) => log('info', 'network', message, data),
    warn: (message: string, data?: unknown) => log('warn', 'network', message, data),
    error: (message: string, data?: unknown) => log('error', 'network', message, data),
  },
  
  state: {
    debug: (message: string, data?: unknown) => log('debug', 'state', message, data),
    info: (message: string, data?: unknown) => log('info', 'state', message, data),
    warn: (message: string, data?: unknown) => log('warn', 'state', message, data),
    error: (message: string, data?: unknown) => log('error', 'state', message, data),
  },

  setEnabled: (enabled: boolean) => {
    isLoggingEnabled = enabled;
    try { localStorage.setItem('logging_enabled', enabled ? 'true' : 'false'); } catch { /* blocked */ }
    if (enabled) {
      log('info', 'general', 'Logging enabled');
    }
  },
  
  isEnabled: () => isLoggingEnabled,
  
  setMetadata: (key: string, value: unknown) => {
    // No prototype guard needed: metadata has no prototype (Object.create(null)),
    // so __proto__ / constructor / toString are just ordinary string keys here.
    metadata[key] = value;
  },
  
  getBuffer: () => [...logBuffer],

  /** True when a log snapshot from the previous page session is available. */
  hasPreviousSessionLog: () => previousSessionLogStr !== null,

  /**
   * Returns the formatted log text captured from the previous page session
   * (populated once on startup, cleared when the tab is reloaded again).
   * Returns null when no previous session data exists.
   */
  getPreviousSessionLog: () => previousSessionLogStr,

  exportLogs: (maxBytes: number = 400_000) => {
    // Redact Gemini API key pattern before any log export.
    // Defence-in-depth: the key should never appear in log messages, but this
    // guards against future regressions where config objects are accidentally logged.
    const redact = (s: string) => s.replace(/AIza[0-9A-Za-z_-]{35}/g, '[API_KEY_REDACTED]');

    const metaStr = Object.keys(metadata).length > 0
      ? `METADATA: ${redact(JSON.stringify(metadata))}\n---\n`
      : '';

    // Format each entry as a single line — large JSON data payloads can make individual
    // entries several KB; we truncate data fields to 500 chars to keep entries compact.
    const formatEntry = (entry: LogEntry): string => {
      const time = formatTime(entry.timestamp);
      let data = '';
      if (entry.data !== undefined) {
        const raw = redact(JSON.stringify(entry.data));
        data = ` | ${raw.length > 500 ? raw.slice(0, 500) + '…' : raw}`;
      }
      return `[${time}] [${entry.level.toUpperCase()}] [${entry.category}] ${redact(entry.message)}${data}`;
    };

    // Android clipboard limit is ~1 MB in theory but Chrome on Android silently fails
    // above ~500 KB. We allow the caller to pass maxBytes (default 400 KB) and trim
    // oldest entries until the output fits — O(n) via pre-computed per-entry lengths.
    const totalEntries = logBuffer.length;
    const formatted = logBuffer.map(formatEntry);
    // +1 for the '\n' separator between entries
    const sizes = formatted.map(s => s.length + 1);
    let totalSize = metaStr.length + sizes.reduce((a, b) => a + b, 0);
    let trimmedCount = 0;

    // Drop oldest entries from the front until total fits within maxBytes
    while (totalSize > maxBytes && trimmedCount < formatted.length - 1) {
      totalSize -= sizes[trimmedCount];
      trimmedCount++;
    }

    const trimNote = trimmedCount > 0
      ? `[LOG TRIMMED: oldest ${trimmedCount} of ${totalEntries} entries removed to fit clipboard limit]\n---\n`
      : '';
    const logsStr = formatted.slice(trimmedCount).join('\n');

    return metaStr + trimNote + logsStr;
  },
  
  clearBuffer: () => {
    logBuffer.length = 0;
  },
  
  timing: (category: LogCategory, label: string) => {
    if (!isLoggingEnabled) return { end: () => 0 };
    const start = performance.now();
    const markName = `${category}_${label}_${start}`;
    try { performance.mark(`${markName}_start`); } catch {}
    return {
      end: (extraData?: unknown) => {
        const duration = performance.now() - start;
        try { 
          performance.mark(`${markName}_end`);
          performance.measure(label, `${markName}_start`, `${markName}_end`);
        } catch {}
        log('debug', category, `${label}: ${duration.toFixed(2)}ms`, extraData);
        return duration;
      }
    };
  },
  
  mark: (name: string) => {
    if (!isLoggingEnabled) return;
    const ts = performance.now();
    try { performance.mark(name); } catch {}
    log('debug', 'general', `MARK: ${name}`, { timestamp: ts });
  },
  
  measure: (name: string, startMark: string, endMark: string) => {
    try {
      const measure = performance.measure(name, startMark, endMark);
      log('debug', 'general', `MEASURE: ${name}`, { duration: measure.duration.toFixed(2) });
      return measure.duration;
    } catch {
      return 0;
    }
  },
  
  getPerformanceEntries: () => {
    return performance.getEntriesByType('measure').map(e => ({
      name: e.name,
      duration: e.duration.toFixed(2),
      startTime: e.startTime.toFixed(2)
    }));
  },
  
  clearPerformanceMarks: () => {
    performance.clearMarks();
    performance.clearMeasures();
  },
  
  logMemory: () => {
    if (!isLoggingEnabled) return;
    const perf = performance as any;
    if (perf.memory) {
      const mem = perf.memory;
      log('debug', 'performance', 'Memory usage', {
        usedJSHeapSize: `${(mem.usedJSHeapSize / 1024 / 1024).toFixed(2)} MB`,
        totalJSHeapSize: `${(mem.totalJSHeapSize / 1024 / 1024).toFixed(2)} MB`,
        jsHeapSizeLimit: `${(mem.jsHeapSizeLimit / 1024 / 1024).toFixed(2)} MB`,
        usagePercent: `${((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100).toFixed(1)}%`
      });
    }
  },
  
  logConnectionQuality: (data: { rtt?: number; downlink?: number; effectiveType?: string }) => {
    if (!isLoggingEnabled) return;
    const conn = (navigator as any).connection;
    const info = {
      rtt: data.rtt ?? conn?.rtt,
      downlink: data.downlink ?? conn?.downlink,
      effectiveType: data.effectiveType ?? conn?.effectiveType,
      saveData: conn?.saveData,
      online: navigator.onLine
    };
    log('debug', 'network', 'Connection quality', info);
  },
  
  logSystemInfo: () => {
    if (!isLoggingEnabled) return;
    const info: Record<string, unknown> = {
      userAgent: navigator.userAgent,
      language: navigator.language,
      online: navigator.onLine,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as any).deviceMemory,
      platform: navigator.platform
    };
    const conn = (navigator as any).connection;
    if (conn) {
      info.connectionType = conn.effectiveType;
      info.connectionRtt = conn.rtt;
      info.connectionDownlink = conn.downlink;
    }
    log('info', 'general', 'System info', info);
  },
  
  logAudioContext: (ctx: AudioContext | null, label: string) => {
    if (!isLoggingEnabled || !ctx) return;
    log('debug', 'audio', `AudioContext (${label})`, {
      state: ctx.state,
      sampleRate: ctx.sampleRate,
      baseLatency: ctx.baseLatency?.toFixed(4),
      outputLatency: (ctx as any).outputLatency?.toFixed(4),
      currentTime: ctx.currentTime.toFixed(3)
    });
  },
  
  createSessionLogger: (sessionId: string) => {
    const prefix = `[Session ${sessionId}]`;
    return {
      debug: (message: string, data?: unknown) => log('debug', 'session', `${prefix} ${message}`, data),
      info: (message: string, data?: unknown) => log('info', 'session', `${prefix} ${message}`, data),
      warn: (message: string, data?: unknown) => log('warn', 'session', `${prefix} ${message}`, data),
      error: (message: string, data?: unknown) => log('error', 'session', `${prefix} ${message}`, data)
    };
  }
};

// Setup global error handlers for uncaught errors
if (typeof window !== 'undefined') {
  // Expose debug helpers only in development builds.
  // In production, these are stripped so the browser console cannot be used
  // as a side-channel to read log history (which may contain diagnostic data).
  if (!import.meta.env.PROD) {
    (window as any).__logger = logger;
    (window as any).__perf = () => logger.getPerformanceEntries();
  }
  
  // Global error handler for uncaught exceptions
  window.onerror = (message, source, lineno, colno, error) => {
    const errorInfo = {
      message: String(message),
      source: source || 'unknown',
      line: lineno,
      column: colno,
      stack: error?.stack || 'no stack'
    };
    log('error', 'general', `Uncaught error: ${message}`, errorInfo);
    // Don't prevent default - let browser still log to console
    return false;
  };
  
  // Global handler for unhandled promise rejections
  window.onunhandledrejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const errorInfo = {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : 'no stack',
      type: typeof reason
    };
    log('error', 'general', `Unhandled promise rejection: ${errorInfo.reason}`, errorInfo);
    // Don't prevent default - let browser still log to console
  };
  
  // Log app startup
  log('info', 'general', 'Application initialized', {
    userAgent: navigator.userAgent,
    language: navigator.language,
    online: navigator.onLine,
    timestamp: new Date().toISOString()
  });
}
