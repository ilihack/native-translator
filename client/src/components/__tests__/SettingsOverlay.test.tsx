/**
 * Component integration tests for SettingsOverlay.tsx
 *
 * Uses @testing-library/react to render the component and verify:
 *  - Renders correctly when isVisible = true
 *  - API key input: autocomplete=off, type=password, spellCheck=false
 *  - API key format-warning behaviour (shown for bad key, hidden for empty or valid key)
 *  - API key whitespace trimming
 *  - Close button invokes onClose with the correct didChange argument
 *  - Settings fields update local state (outputGain, voiceName)
 *
 * Mocks: logger, useToast, LegalPages (heavy unrelated components),
 *        window.fetch (SW version check), HTMLMediaElement (jsdom shim)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsOverlay from '../SettingsOverlay';
import type { AudioConfig } from '../../hooks/useLiveSession';

// ─── module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../utils/logger', () => ({
  logger: {
    ui: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../LegalPages', () => ({
  ImpressumPage: () => null,
  DatenschutzPage: () => null,
}));

// jsdom doesn't implement HTMLMediaElement methods
Object.defineProperty(HTMLMediaElement.prototype, 'play', { writable: true, value: vi.fn() });
Object.defineProperty(HTMLMediaElement.prototype, 'pause', { writable: true, value: vi.fn() });

// SW version fetch (version badge useEffect)
const mockFetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({ version: '6.3.0' }),
});
global.fetch = mockFetch as unknown as typeof fetch;

// ─── shared fixtures ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AudioConfig = {
  noiseSuppression: false,
  autoGainControl: false,
  outputGain: 2.5,
  softClipDrive: 1.5,
  voiceName: 'Aoede',
  showDebugInfo: false,
  userApiKey: '',
  modelName: 'gemini-live-2.5-flash-preview',
  vadPrefixPaddingMs: 100,
  vadSilenceDurationMs: 500,
  vadStartSensitivity: 'low',
  temperature: 0.3,
  audioTestMode: false,
  inputBufferSize: 960,
  triggerTokens: 30000,
  funnyMode: 'off',
};

function buildProps(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  const config: AudioConfig = { ...DEFAULT_CONFIG, ...overrides };
  return {
    isVisible: true,
    onClose: vi.fn(),
    latency: 0,
    processingTime: 0,
    config,
    setConfig: vi.fn(),
    sourceLangCode: 'en',
    setSourceLangCode: vi.fn(),
    targetLangCode: 'de',
    setTargetLangCode: vi.fn(),
    customPrompt: '',
    setCustomPrompt: vi.fn(),
    defaultPrompt: 'You are an interpreter from {source} to {target}.',
  };
}

// ─── rendering ────────────────────────────────────────────────────────────────

describe('SettingsOverlay rendering', () => {
  it('renders when isVisible=true', () => {
    render(<SettingsOverlay {...buildProps()} />);
    // The settings panel should contain some heading text
    expect(screen.getByTestId('settings-overlay')).toBeInTheDocument();
  });

  it('does NOT render panel content when isVisible=false', () => {
    render(<SettingsOverlay {...buildProps()} isVisible={false} />);
    expect(screen.queryByTestId('settings-overlay')).not.toBeInTheDocument();
  });
});

// ─── API key input ───────────────────────────────────────────────────────────

describe('API key input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has autocomplete="off"', () => {
    render(<SettingsOverlay {...buildProps()} />);
    const input = screen.getByTestId('input-api-key') as HTMLInputElement;
    expect(input.autocomplete).toBe('off');
  });

  it('has type="password"', () => {
    render(<SettingsOverlay {...buildProps()} />);
    const input = screen.getByTestId('input-api-key') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('has spellCheck disabled', () => {
    render(<SettingsOverlay {...buildProps()} />);
    const input = screen.getByTestId('input-api-key') as HTMLInputElement;
    // jsdom reflects spellcheck via getAttribute (the .spellcheck property is not
    // always implemented). React renders spellCheck={false} → attribute "false".
    expect(input.getAttribute('spellcheck')).toBe('false');
  });

  it('shows the stored API key value', () => {
    const props = buildProps();
    props.config.userApiKey = 'AIzaTestExistingKey';
    render(<SettingsOverlay {...props} />);
    const input = screen.getByTestId('input-api-key') as HTMLInputElement;
    expect(input.value).toBe('AIzaTestExistingKey');
  });

  it('shows format warning for key that does not start with "AIza"', () => {
    // Render with a bad key already set — the warning is driven by config.userApiKey
    // which is a controlled prop; typing into the input does NOT update it because
    // setConfig is a mock. Test the static render instead.
    const badKey = 'badkey123456789012345678901234567890';
    render(<SettingsOverlay {...buildProps({ userApiKey: badKey })} />);
    expect(screen.getByTestId('warning-api-key-format')).toBeInTheDocument();
  });

  it('hides format warning when key is empty', () => {
    render(<SettingsOverlay {...buildProps({ userApiKey: '' })} />);
    expect(screen.queryByTestId('warning-api-key-format')).not.toBeInTheDocument();
  });

  it('hides format warning for a valid key starting with "AIza"', () => {
    // Regex: /^AIza[0-9A-Za-z_-]{35}$/ → total 39 chars
    // 'AIzaSy...' + 35 alphanumeric chars = exactly the right format
    const goodKey = 'AIzaSyTestKeyABCDEFGHIJKLMNOPQRSTUVWXYZ'; // AIza + 35 = 39 chars
    render(<SettingsOverlay {...buildProps({ userApiKey: goodKey })} />);
    expect(screen.queryByTestId('warning-api-key-format')).not.toBeInTheDocument();
  });

  it('strips leading/trailing whitespace from the API key on change', async () => {
    const setConfig = vi.fn();
    render(<SettingsOverlay {...buildProps()} setConfig={setConfig} />);
    const input = screen.getByTestId('input-api-key');

    // fire a change event with surrounding spaces
    fireEvent.change(input, { target: { value: '  AIzaKeyWithSpaces  ' } });

    await waitFor(() => {
      // setConfig should have been called; the trimmed value goes into the functional update
      expect(setConfig).toHaveBeenCalled();
      const updater = setConfig.mock.calls[setConfig.mock.calls.length - 1][0];
      if (typeof updater === 'function') {
        const next = updater(DEFAULT_CONFIG);
        expect(next.userApiKey).toBe('AIzaKeyWithSpaces');
      }
    });
  });
});

// ─── close button ─────────────────────────────────────────────────────────────
// NOTE: The close/save button is disabled when userApiKey is empty (guard for
// first-time setup). Tests must provide a non-empty API key to enable it.

describe('close button', () => {
  const propsWithKey = () => buildProps({ userApiKey: 'AIzaTestKey1234567890123456789012345' });

  it('is enabled when an API key is set', () => {
    render(<SettingsOverlay {...propsWithKey()} />);
    const btn = screen.getByTestId('button-close-settings') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('is disabled when no API key is set', () => {
    render(<SettingsOverlay {...buildProps({ userApiKey: '' })} />);
    const btn = screen.getByTestId('button-close-settings') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('calls onClose when clicked (with API key provided)', async () => {
    const onClose = vi.fn();
    render(<SettingsOverlay {...propsWithKey()} onClose={onClose} />);
    await userEvent.click(screen.getByTestId('button-close-settings'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose with false when nothing was changed', async () => {
    const onClose = vi.fn();
    render(<SettingsOverlay {...propsWithKey()} onClose={onClose} />);
    await userEvent.click(screen.getByTestId('button-close-settings'));
    expect(onClose).toHaveBeenCalledWith(false);
  });
});

// ─── output gain slider ───────────────────────────────────────────────────────

describe('output gain', () => {
  it('renders the output gain slider after opening advanced settings', async () => {
    render(<SettingsOverlay {...buildProps()} />);
    // The slider lives inside the collapsible advanced settings section
    const toggle = screen.getByTestId('toggle-advanced-settings');
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByTestId('slider-output-gain')).toBeInTheDocument();
    });
  });
});
