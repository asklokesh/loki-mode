import { useState, useEffect, useCallback } from 'react';
import {
  Settings2,
  Palette,
  Code,
  Hammer,
  Cloud,
  Keyboard,
  Eye,
  Info,
  ExternalLink,
  Search,
  RotateCcw,
  Check,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { api } from '../api/client';
import { SettingToggle } from '../components/settings/SettingToggle';
import { SettingSelect } from '../components/settings/SettingSelect';
import { SettingSlider } from '../components/settings/SettingSlider';
import { SettingInput } from '../components/settings/SettingInput';
import { Divider as DesignDivider } from '../components/Divider';

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const LS_PREFIX = 'pl_settings_';

function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${key}`);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveSetting<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // storage full or unavailable
  }
}

// ---------------------------------------------------------------------------
// Settings category definitions
// ---------------------------------------------------------------------------

type CategoryId =
  | 'general'
  | 'appearance'
  | 'editor'
  | 'build'
  | 'providers'
  | 'shortcuts'
  | 'accessibility'
  | 'about';

interface CategoryDef {
  id: CategoryId;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}

const CATEGORIES: CategoryDef[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'editor', label: 'Editor', icon: Code },
  { id: 'build', label: 'Build', icon: Hammer },
  { id: 'providers', label: 'Providers', icon: Cloud },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: Keyboard },
  { id: 'accessibility', label: 'Accessibility', icon: Eye },
  { id: 'about', label: 'About', icon: Info },
];

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

interface ProviderDef {
  id: string;
  name: string;
  description: string;
  models: string[];
  defaultModel: string;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    name: 'Claude',
    description: 'Anthropic Claude Code -- full features (Opus 4.7 default, 1M context)',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-opus-4-7',
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex CLI -- degraded mode',
    models: ['gpt-5.3-codex', 'o3', 'o4-mini'],
    defaultModel: 'gpt-5.3-codex',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    description: 'Google Gemini CLI -- degraded mode',
    models: ['gemini-3-pro-medium', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    defaultModel: 'gemini-3-pro-medium',
  },
  {
    id: 'cline',
    name: 'Cline',
    description: 'VS Code extension -- sequential mode',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-4.1'],
    defaultModel: 'claude-opus-4-7',
  },
  {
    id: 'aider',
    name: 'Aider',
    description: 'Terminal-based pair programming',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-4.1', 'ollama_chat/deepseek-coder'],
    defaultModel: 'claude-opus-4-7',
  },
];

// ---------------------------------------------------------------------------
// Shortcut definitions
// ---------------------------------------------------------------------------

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
const mod = isMac ? 'Cmd' : 'Ctrl';

interface ShortcutDef {
  action: string;
  keys: string;
  category: string;
}

const SHORTCUTS: ShortcutDef[] = [
  { action: 'Save file', keys: `${mod}+S`, category: 'File' },
  { action: 'Quick open file', keys: `${mod}+P`, category: 'File' },
  { action: 'Command palette', keys: `${mod}+K`, category: 'Navigation' },
  { action: 'Toggle terminal', keys: `${mod}+\``, category: 'Navigation' },
  { action: 'Start / stop build', keys: `${mod}+B`, category: 'Build' },
  { action: 'Show keyboard shortcuts', keys: `${mod}+?`, category: 'Help' },
  { action: 'Close modals', keys: 'Escape', category: 'Navigation' },
  { action: 'Focus search', keys: `${mod}+F`, category: 'Navigation' },
  { action: 'Toggle sidebar', keys: `${mod}+\\`, category: 'Navigation' },
  { action: 'New project', keys: `${mod}+N`, category: 'File' },
  { action: 'Go to settings', keys: `${mod}+,`, category: 'Navigation' },
];

// ---------------------------------------------------------------------------
// Section separator component
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-[#939084] mb-3 mt-6 first:mt-0">
      {children}
    </h3>
  );
}

function Divider() {
  return <DesignDivider className="my-1" />;
}

// ---------------------------------------------------------------------------
// Main settings page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const [activeCategory, setActiveCategory] = useState<CategoryId>('general');

  // -- General settings state --
  const [projectDir, setProjectDir] = useState(() => loadSetting('projectDir', '~/projects'));
  const [autoSave, setAutoSave] = useState(() => loadSetting('autoSave', true));
  const [autoSaveInterval, setAutoSaveInterval] = useState(() => loadSetting('autoSaveInterval', '15'));
  const [language, setLanguage] = useState(() => loadSetting('language', 'en'));
  const [telemetry, setTelemetry] = useState(() => loadSetting('telemetry', false));

  // -- Appearance settings state --
  const [themeMode, setThemeMode] = useState<'light' | 'dark' | 'system'>(() => {
    const stored = localStorage.getItem('pl_theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return 'system';
  });
  const [accentColor, setAccentColor] = useState(() => loadSetting('accentColor', 'purple'));
  const [fontSize, setFontSize] = useState(() => loadSetting('fontSize', 'medium'));
  const [sidebarPosition, setSidebarPosition] = useState(() => loadSetting('sidebarPosition', 'left'));
  const [compactMode, setCompactMode] = useState(() => loadSetting('compactMode', false));
  const [animationLevel, setAnimationLevel] = useState(() => loadSetting('animationLevel', 'full'));

  // -- Editor settings state --
  const [editorFont, setEditorFont] = useState(() => loadSetting('editorFont', 'JetBrains Mono'));
  const [editorFontSize, setEditorFontSize] = useState(() => loadSetting('editorFontSize', 14));
  const [tabSize, setTabSize] = useState(() => loadSetting('tabSize', '2'));
  const [wordWrap, setWordWrap] = useState(() => loadSetting('wordWrap', true));
  const [lineNumbers, setLineNumbers] = useState(() => loadSetting('lineNumbers', true));
  const [minimap, setMinimap] = useState(() => loadSetting('minimap', true));
  const [bracketMatching, setBracketMatching] = useState(() => loadSetting('bracketMatching', true));

  // -- Build settings state --
  const [defaultProvider, setDefaultProvider] = useState(() => loadSetting('defaultProvider', 'claude'));
  const [maxIterations, setMaxIterations] = useState(() => loadSetting('maxIterations', 25));
  const [qualityStrictness, setQualityStrictness] = useState(() => loadSetting('qualityStrictness', 'standard'));
  const [autoDeploy, setAutoDeploy] = useState(() => loadSetting('autoDeploy', false));
  const [budgetLimit, setBudgetLimit] = useState(() => loadSetting('budgetLimit', ''));
  const [buildNotifications, setBuildNotifications] = useState(() => loadSetting('buildNotifications', true));

  // -- Provider settings state --
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>(() => loadSetting('providerKeys', {}));
  const [providerModels, setProviderModels] = useState<Record<string, string>>(() => loadSetting('providerModels', {}));
  const [providerPriority, setProviderPriority] = useState<string[]>(() =>
    loadSetting('providerPriority', ['claude', 'codex', 'gemini', 'cline', 'aider'])
  );
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, 'success' | 'error'>>({});

  // -- Accessibility settings state --
  const [highContrast, setHighContrast] = useState(() => loadSetting('highContrast', false));
  const [focusIndicator, setFocusIndicator] = useState(() => loadSetting('focusIndicator', 'default'));
  const [motionPref, setMotionPref] = useState(() => loadSetting('motionPref', 'full'));
  const [screenReaderAnnouncements, setScreenReaderAnnouncements] = useState(() => loadSetting('screenReaderAnnouncements', true));
  const [fontScaling, setFontScaling] = useState(() => loadSetting('fontScaling', '100'));

  // -- About state --
  const [version, setVersion] = useState('');

  // -- Keyboard shortcuts filter --
  const [shortcutFilter, setShortcutFilter] = useState('');

  // -------------------------------------------------------------------------
  // Persistence: save each setting to localStorage on change
  // -------------------------------------------------------------------------

  useEffect(() => { saveSetting('projectDir', projectDir); }, [projectDir]);
  useEffect(() => { saveSetting('autoSave', autoSave); }, [autoSave]);
  useEffect(() => { saveSetting('autoSaveInterval', autoSaveInterval); }, [autoSaveInterval]);
  useEffect(() => { saveSetting('language', language); }, [language]);
  useEffect(() => { saveSetting('telemetry', telemetry); }, [telemetry]);

  // Theme applies to document
  useEffect(() => {
    if (themeMode === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', prefersDark);
      localStorage.removeItem('pl_theme');
    } else {
      document.documentElement.classList.toggle('dark', themeMode === 'dark');
      localStorage.setItem('pl_theme', themeMode);
    }
  }, [themeMode]);

  useEffect(() => { saveSetting('accentColor', accentColor); }, [accentColor]);
  useEffect(() => { saveSetting('fontSize', fontSize); }, [fontSize]);
  useEffect(() => { saveSetting('sidebarPosition', sidebarPosition); }, [sidebarPosition]);
  useEffect(() => { saveSetting('compactMode', compactMode); }, [compactMode]);
  useEffect(() => { saveSetting('animationLevel', animationLevel); }, [animationLevel]);

  useEffect(() => { saveSetting('editorFont', editorFont); }, [editorFont]);
  useEffect(() => { saveSetting('editorFontSize', editorFontSize); }, [editorFontSize]);
  useEffect(() => { saveSetting('tabSize', tabSize); }, [tabSize]);
  useEffect(() => { saveSetting('wordWrap', wordWrap); }, [wordWrap]);
  useEffect(() => { saveSetting('lineNumbers', lineNumbers); }, [lineNumbers]);
  useEffect(() => { saveSetting('minimap', minimap); }, [minimap]);
  useEffect(() => { saveSetting('bracketMatching', bracketMatching); }, [bracketMatching]);

  useEffect(() => { saveSetting('defaultProvider', defaultProvider); }, [defaultProvider]);
  useEffect(() => { saveSetting('maxIterations', maxIterations); }, [maxIterations]);
  useEffect(() => { saveSetting('qualityStrictness', qualityStrictness); }, [qualityStrictness]);
  useEffect(() => { saveSetting('autoDeploy', autoDeploy); }, [autoDeploy]);
  useEffect(() => { saveSetting('budgetLimit', budgetLimit); }, [budgetLimit]);
  useEffect(() => { saveSetting('buildNotifications', buildNotifications); }, [buildNotifications]);

  useEffect(() => { saveSetting('providerKeys', providerKeys); }, [providerKeys]);
  useEffect(() => { saveSetting('providerModels', providerModels); }, [providerModels]);
  useEffect(() => { saveSetting('providerPriority', providerPriority); }, [providerPriority]);

  useEffect(() => { saveSetting('highContrast', highContrast); }, [highContrast]);
  useEffect(() => { saveSetting('focusIndicator', focusIndicator); }, [focusIndicator]);
  useEffect(() => { saveSetting('motionPref', motionPref); }, [motionPref]);
  useEffect(() => { saveSetting('screenReaderAnnouncements', screenReaderAnnouncements); }, [screenReaderAnnouncements]);
  useEffect(() => { saveSetting('fontScaling', fontScaling); }, [fontScaling]);

  // Apply font scaling to root
  useEffect(() => {
    const scale = parseInt(fontScaling, 10);
    document.documentElement.style.fontSize = `${(15 * scale) / 100}px`;
    return () => {
      document.documentElement.style.fontSize = '';
    };
  }, [fontScaling]);

  // Apply high contrast class
  useEffect(() => {
    document.documentElement.classList.toggle('high-contrast', highContrast);
  }, [highContrast]);

  // Apply motion preference
  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', motionPref === 'reduced');
    document.documentElement.classList.toggle('no-motion', motionPref === 'none');
  }, [motionPref]);

  // Apply enhanced focus indicators
  useEffect(() => {
    document.documentElement.classList.toggle('enhanced-focus', focusIndicator === 'enhanced');
  }, [focusIndicator]);

  // -------------------------------------------------------------------------
  // Fetch version from API
  // -------------------------------------------------------------------------

  useEffect(() => {
    api.getStatus()
      .then((s) => setVersion(s.version || ''))
      .catch(() => {});
  }, []);

  // -------------------------------------------------------------------------
  // Provider test connection
  // -------------------------------------------------------------------------

  const handleTestConnection = useCallback(async (providerId: string) => {
    setTestingProvider(providerId);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[providerId];
      return next;
    });

    try {
      await api.setProvider(providerId);
      const info = await api.getCurrentProvider();
      if (info.provider === providerId) {
        setTestResults((prev) => ({ ...prev, [providerId]: 'success' }));
      } else {
        setTestResults((prev) => ({ ...prev, [providerId]: 'error' }));
      }
    } catch {
      setTestResults((prev) => ({ ...prev, [providerId]: 'error' }));
    } finally {
      setTestingProvider(null);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Provider priority reorder
  // -------------------------------------------------------------------------

  const moveProviderPriority = useCallback((providerId: string, direction: 'up' | 'down') => {
    setProviderPriority((prev) => {
      const idx = prev.indexOf(providerId);
      if (idx === -1) return prev;
      const newIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // Render category content
  // -------------------------------------------------------------------------

  function renderContent() {
    switch (activeCategory) {
      case 'general':
        return <GeneralSettings />;
      case 'appearance':
        return <AppearanceSettings />;
      case 'editor':
        return <EditorSettings />;
      case 'build':
        return <BuildSettings />;
      case 'providers':
        return <ProviderSettings />;
      case 'shortcuts':
        return <ShortcutSettings />;
      case 'accessibility':
        return <AccessibilitySettings />;
      case 'about':
        return <AboutSettings />;
      default:
        return null;
    }
  }

  // =========================================================================
  // Category panels
  // =========================================================================

  function GeneralSettings() {
    return (
      <div>
        <SectionHeading>Project</SectionHeading>
        <SettingInput
          label="Default project directory"
          description="New projects will be created in this directory"
          value={projectDir}
          onChange={setProjectDir}
          placeholder="~/projects"
        />
        <Divider />

        <SectionHeading>Saving</SectionHeading>
        <SettingToggle
          label="Auto-save"
          description="Automatically save files when modified"
          value={autoSave}
          onChange={setAutoSave}
        />
        <SettingSelect
          label="Auto-save interval"
          description="How often to auto-save open files"
          options={[
            { value: '5', label: '5 seconds' },
            { value: '15', label: '15 seconds' },
            { value: '30', label: '30 seconds' },
            { value: '60', label: '60 seconds' },
          ]}
          value={autoSaveInterval}
          onChange={setAutoSaveInterval}
          disabled={!autoSave}
        />
        <Divider />

        <SectionHeading>Preferences</SectionHeading>
        <SettingSelect
          label="Language"
          description="Interface language"
          options={[
            { value: 'en', label: 'English' },
          ]}
          value={language}
          onChange={setLanguage}
        />
        <SettingToggle
          label="Telemetry"
          description="Help improve Purple Lab by sending anonymous usage data"
          value={telemetry}
          onChange={setTelemetry}
        />
      </div>
    );
  }

  function AppearanceSettings() {
    const accentColors = [
      { id: 'purple', color: '#553DE9', label: 'Purple' },
      { id: 'blue', color: '#2563EB', label: 'Blue' },
      { id: 'green', color: '#059669', label: 'Green' },
      { id: 'orange', color: '#D97706', label: 'Orange' },
      { id: 'pink', color: '#DB2777', label: 'Pink' },
    ];

    const fontSizePreview: Record<string, string> = {
      small: 'text-xs',
      medium: 'text-sm',
      large: 'text-base',
    };

    return (
      <div>
        <SectionHeading>Theme</SectionHeading>
        <div className="py-3">
          <label className="text-sm font-medium text-[#36342E] block mb-3">Color theme</label>
          <div className="flex gap-3">
            {(['light', 'dark', 'system'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setThemeMode(mode)}
                className={[
                  'flex-1 flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-colors',
                  themeMode === mode
                    ? 'border-[#553DE9] bg-[#553DE9]/5'
                    : 'border-[#ECEAE3] hover:border-[#553DE9]/30',
                ].join(' ')}
                aria-pressed={themeMode === mode}
              >
                {/* Mini preview */}
                <div
                  className={[
                    'w-full h-12 rounded border flex items-end px-1.5 pb-1.5 gap-1',
                    mode === 'dark'
                      ? 'bg-[#1A1A1E] border-[#2A2A30]'
                      : mode === 'light'
                      ? 'bg-white border-[#ECEAE3]'
                      : 'bg-gradient-to-r from-white to-[#1A1A1E] border-[#ECEAE3]',
                  ].join(' ')}
                >
                  <div className={`w-2 h-4 rounded-sm ${mode === 'dark' ? 'bg-[#2A2A30]' : 'bg-[#ECEAE3]'}`} />
                  <div className={`w-4 h-3 rounded-sm ${mode === 'dark' ? 'bg-[#2A2A30]' : 'bg-[#ECEAE3]'}`} />
                  <div className={`w-3 h-5 rounded-sm ${mode === 'dark' ? 'bg-[#2A2A30]' : 'bg-[#ECEAE3]'}`} />
                </div>
                <span className="text-xs font-medium text-[#36342E] capitalize">{mode}</span>
              </button>
            ))}
          </div>
        </div>
        <Divider />

        <SectionHeading>Accent color</SectionHeading>
        <div className="py-3">
          <div className="flex gap-3">
            {accentColors.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setAccentColor(c.id)}
                className="flex flex-col items-center gap-1.5 group"
                aria-label={c.label}
                aria-pressed={accentColor === c.id}
              >
                <div
                  className={[
                    'w-8 h-8 rounded-full transition-all',
                    accentColor === c.id
                      ? 'ring-2 ring-offset-2 ring-[#553DE9] scale-110'
                      : 'group-hover:scale-105',
                  ].join(' ')}
                  style={{ backgroundColor: c.color }}
                />
                <span className="text-[11px] text-[#6B6960]">{c.label}</span>
              </button>
            ))}
          </div>
        </div>
        <Divider />

        <SectionHeading>Layout</SectionHeading>
        <SettingSelect
          label="Font size"
          description="Base font size for the interface"
          options={[
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ]}
          value={fontSize}
          onChange={setFontSize}
        />
        {/* Preview text */}
        <div className="pl-4 pb-2">
          <span className={`${fontSizePreview[fontSize]} text-[#6B6960] italic`}>
            The quick brown fox jumps over the lazy dog.
          </span>
        </div>

        <SettingSelect
          label="Sidebar position"
          description="Which side the navigation sidebar appears on"
          options={[
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
          ]}
          value={sidebarPosition}
          onChange={setSidebarPosition}
        />
        <SettingToggle
          label="Compact mode"
          description="Reduce padding and spacing throughout the interface"
          value={compactMode}
          onChange={setCompactMode}
        />
        <SettingSelect
          label="Animations"
          description="Control interface transition animations"
          options={[
            { value: 'full', label: 'Full' },
            { value: 'reduced', label: 'Reduced' },
            { value: 'none', label: 'None' },
          ]}
          value={animationLevel}
          onChange={setAnimationLevel}
        />
      </div>
    );
  }

  function EditorSettings() {
    return (
      <div>
        <SectionHeading>Font</SectionHeading>
        <SettingSelect
          label="Font family"
          description="Font used in the code editor"
          options={[
            { value: 'JetBrains Mono', label: 'JetBrains Mono' },
            { value: 'Fira Code', label: 'Fira Code' },
            { value: 'Source Code Pro', label: 'Source Code Pro' },
            { value: 'Consolas', label: 'Consolas' },
          ]}
          value={editorFont}
          onChange={setEditorFont}
        />
        <SettingSlider
          label="Font size"
          description="Size of text in the code editor"
          min={12}
          max={24}
          value={editorFontSize}
          onChange={setEditorFontSize}
          unit="px"
        />

        {/* Editor preview */}
        <div className="my-3 rounded-lg border border-[#ECEAE3] overflow-hidden">
          <div className="bg-[#FAF9F6] px-3 py-1.5 border-b border-[#ECEAE3]">
            <span className="text-[11px] text-[#939084]">Preview</span>
          </div>
          <div className="bg-white p-4">
            <pre
              className="text-[#36342E] leading-relaxed"
              style={{
                fontFamily: `"${editorFont}", monospace`,
                fontSize: `${editorFontSize}px`,
              }}
            >{`function greet(name) {
  return \`Hello, \${name}!\`;
}

greet("world");`}</pre>
          </div>
        </div>
        <Divider />

        <SectionHeading>Formatting</SectionHeading>
        <SettingSelect
          label="Tab size"
          description="Number of spaces per tab"
          options={[
            { value: '2', label: '2 spaces' },
            { value: '4', label: '4 spaces' },
            { value: '8', label: '8 spaces' },
          ]}
          value={tabSize}
          onChange={setTabSize}
        />
        <SettingToggle
          label="Word wrap"
          description="Wrap long lines to fit the editor width"
          value={wordWrap}
          onChange={setWordWrap}
        />
        <Divider />

        <SectionHeading>Display</SectionHeading>
        <SettingToggle
          label="Line numbers"
          description="Show line numbers in the gutter"
          value={lineNumbers}
          onChange={setLineNumbers}
        />
        <SettingToggle
          label="Minimap"
          description="Show a miniature overview of the file"
          value={minimap}
          onChange={setMinimap}
        />
        <SettingToggle
          label="Bracket matching"
          description="Highlight matching brackets"
          value={bracketMatching}
          onChange={setBracketMatching}
        />
      </div>
    );
  }

  function BuildSettings() {
    return (
      <div>
        <SectionHeading>Provider</SectionHeading>
        <SettingSelect
          label="Default provider"
          description="AI provider to use for new builds"
          options={PROVIDERS.map((p) => ({ value: p.id, label: p.name }))}
          value={defaultProvider}
          onChange={setDefaultProvider}
        />
        <Divider />

        <SectionHeading>Execution</SectionHeading>
        <SettingSlider
          label="Max iterations"
          description="Maximum number of RARV iterations per build"
          min={5}
          max={50}
          value={maxIterations}
          onChange={setMaxIterations}
          step={5}
        />
        <SettingSelect
          label="Quality gate strictness"
          description="How strict the quality gates are during builds"
          options={[
            { value: 'relaxed', label: 'Relaxed' },
            { value: 'standard', label: 'Standard' },
            { value: 'strict', label: 'Strict' },
          ]}
          value={qualityStrictness}
          onChange={setQualityStrictness}
        />
        <Divider />

        <SectionHeading>Automation</SectionHeading>
        <SettingToggle
          label="Auto-deploy on success"
          description="Automatically deploy when build completes successfully"
          value={autoDeploy}
          onChange={setAutoDeploy}
        />
        <SettingInput
          label="Budget limit"
          description="Maximum spend per build (leave empty for unlimited)"
          type="number"
          value={budgetLimit}
          onChange={setBudgetLimit}
          placeholder="e.g. 10.00"
        />
        <SettingToggle
          label="Build notifications"
          description="Show browser notifications for build events"
          value={buildNotifications}
          onChange={setBuildNotifications}
        />
      </div>
    );
  }

  function ProviderSettings() {
    return (
      <div>
        <SectionHeading>Configured providers</SectionHeading>
        <div className="flex flex-col gap-4 mt-2">
          {providerPriority.map((pid, idx) => {
            const prov = PROVIDERS.find((p) => p.id === pid);
            if (!prov) return null;

            return (
              <div
                key={prov.id}
                className="border border-[#ECEAE3] rounded-lg p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 flex items-center justify-center rounded-full bg-[#553DE9]/10 text-[#553DE9] text-xs font-bold">
                      {idx + 1}
                    </span>
                    <div>
                      <h4 className="text-sm font-medium text-[#36342E]">{prov.name}</h4>
                      <p className="text-xs text-[#6B6960]">{prov.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveProviderPriority(prov.id, 'up')}
                      disabled={idx === 0}
                      className="px-2 py-1 text-xs text-[#6B6960] hover:text-[#36342E] disabled:opacity-30 disabled:cursor-not-allowed"
                      aria-label={`Move ${prov.name} up`}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      onClick={() => moveProviderPriority(prov.id, 'down')}
                      disabled={idx === providerPriority.length - 1}
                      className="px-2 py-1 text-xs text-[#6B6960] hover:text-[#36342E] disabled:opacity-30 disabled:cursor-not-allowed"
                      aria-label={`Move ${prov.name} down`}
                    >
                      Down
                    </button>
                  </div>
                </div>

                <SettingInput
                  label="API key"
                  type="password"
                  value={providerKeys[prov.id] || ''}
                  onChange={(v) =>
                    setProviderKeys((prev) => ({ ...prev, [prov.id]: v }))
                  }
                  placeholder={`Enter ${prov.name} API key`}
                />
                <SettingSelect
                  label="Model"
                  options={prov.models.map((m) => ({ value: m, label: m }))}
                  value={providerModels[prov.id] || prov.defaultModel}
                  onChange={(v) =>
                    setProviderModels((prev) => ({ ...prev, [prov.id]: v }))
                  }
                />

                <div className="flex items-center gap-3 mt-2">
                  <button
                    type="button"
                    onClick={() => handleTestConnection(prov.id)}
                    disabled={testingProvider !== null}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-[#553DE9] text-[#553DE9] hover:bg-[#E8E4FD] rounded-lg transition-colors disabled:opacity-50"
                  >
                    {testingProvider === prov.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : null}
                    Test Connection
                  </button>
                  {testResults[prov.id] === 'success' && (
                    <span className="inline-flex items-center gap-1 text-xs text-[#059669]">
                      <Check size={12} /> Connected
                    </span>
                  )}
                  {testResults[prov.id] === 'error' && (
                    <span className="inline-flex items-center gap-1 text-xs text-[#C45B5B]">
                      <AlertCircle size={12} /> Connection failed
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 p-3 rounded-lg bg-[#FAF9F6] border border-[#ECEAE3]">
          <p className="text-xs text-[#6B6960]">
            Priority order determines the fallback chain. If the primary provider fails, the next one in order will be used.
            Use the Up/Down buttons to reorder.
          </p>
        </div>
      </div>
    );
  }

  function ShortcutSettings() {
    const filtered = shortcutFilter
      ? SHORTCUTS.filter(
          (s) =>
            s.action.toLowerCase().includes(shortcutFilter.toLowerCase()) ||
            s.keys.toLowerCase().includes(shortcutFilter.toLowerCase()) ||
            s.category.toLowerCase().includes(shortcutFilter.toLowerCase())
        )
      : SHORTCUTS;

    const categories = [...new Set(filtered.map((s) => s.category))];

    return (
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#939084]" />
            <input
              type="text"
              value={shortcutFilter}
              onChange={(e) => setShortcutFilter(e.target.value)}
              placeholder="Search shortcuts..."
              className="w-full pl-8 pr-3 py-2 text-sm border border-[#ECEAE3] rounded-lg bg-white text-[#36342E] focus:border-[#553DE9] focus:outline-none focus:ring-1 focus:ring-[#553DE9] placeholder:text-[#939084]"
              aria-label="Search keyboard shortcuts"
            />
          </div>
          <button
            type="button"
            onClick={() => setShortcutFilter('')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-[#6B6960] hover:text-[#36342E] border border-[#ECEAE3] rounded-lg hover:bg-[#F8F4F0] transition-colors"
          >
            <RotateCcw size={12} />
            Reset to defaults
          </button>
        </div>

        {categories.map((cat) => (
          <div key={cat}>
            <SectionHeading>{cat}</SectionHeading>
            <div className="flex flex-col">
              {filtered
                .filter((s) => s.category === cat)
                .map((s) => (
                  <div
                    key={s.action}
                    className="flex items-center justify-between py-2.5 px-2 rounded-lg hover:bg-[#FAF9F6]"
                  >
                    <span className="text-sm text-[#36342E]">{s.action}</span>
                    <kbd className="px-2.5 py-1 text-xs font-mono bg-[#FAF9F6] border border-[#ECEAE3] rounded-md text-[#6B6960]">
                      {s.keys}
                    </kbd>
                  </div>
                ))}
            </div>
          </div>
        ))}

        <div className="mt-6 p-3 rounded-lg bg-[#FAF9F6] border border-[#ECEAE3]">
          <p className="text-xs text-[#6B6960]">
            Press <kbd className="px-1.5 py-0.5 text-[11px] font-mono bg-white border border-[#ECEAE3] rounded">{mod}+?</kbd> anywhere to see keyboard shortcuts.
          </p>
        </div>
      </div>
    );
  }

  function AccessibilitySettings() {
    return (
      <div>
        <SectionHeading>Vision</SectionHeading>
        <SettingToggle
          label="High contrast mode"
          description="Increase contrast for text and UI elements"
          value={highContrast}
          onChange={setHighContrast}
        />
        <SettingSelect
          label="Focus indicators"
          description="Visibility of keyboard focus outlines"
          options={[
            { value: 'default', label: 'Default' },
            { value: 'enhanced', label: 'Enhanced (thicker, more visible)' },
          ]}
          value={focusIndicator}
          onChange={setFocusIndicator}
        />
        <SettingSelect
          label="Font scaling"
          description="Scale all text in the interface"
          options={[
            { value: '100', label: '100%' },
            { value: '125', label: '125%' },
            { value: '150', label: '150%' },
          ]}
          value={fontScaling}
          onChange={setFontScaling}
        />
        <Divider />

        <SectionHeading>Motion</SectionHeading>
        <SettingSelect
          label="Motion preference"
          description="Control animations and transitions"
          options={[
            { value: 'full', label: 'Full -- all animations enabled' },
            { value: 'reduced', label: 'Reduced -- minimal animations' },
            { value: 'none', label: 'None -- no animations' },
          ]}
          value={motionPref}
          onChange={setMotionPref}
        />
        <Divider />

        <SectionHeading>Screen reader</SectionHeading>
        <SettingToggle
          label="Screen reader announcements"
          description="Enable additional ARIA live region announcements"
          value={screenReaderAnnouncements}
          onChange={setScreenReaderAnnouncements}
        />

        <div className="mt-6 p-3 rounded-lg bg-[#FAF9F6] border border-[#ECEAE3]">
          <p className="text-xs text-[#6B6960]">
            Purple Lab is designed to work with assistive technologies. All interactive elements include proper ARIA labels and keyboard navigation support. If you encounter accessibility issues, please report them via the About section.
          </p>
        </div>
      </div>
    );
  }

  function AboutSettings() {
    return (
      <div>
        <SectionHeading>Purple Lab</SectionHeading>
        <div className="py-3">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-[#553DE9] flex items-center justify-center">
              <span className="text-white font-heading font-bold text-lg">PL</span>
            </div>
            <div>
              <h3 className="text-base font-heading font-bold text-[#36342E]">Purple Lab</h3>
              <p className="text-xs text-[#6B6960]">Powered by Loki Mode</p>
            </div>
          </div>

          <div className="border border-[#ECEAE3] rounded-lg divide-y divide-[#ECEAE3]">
            {version && (
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-[#6B6960]">Version</span>
                <span className="text-sm font-mono font-medium text-[#36342E]">v{version}</span>
              </div>
            )}
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-[#6B6960]">Build date</span>
              <span className="text-sm font-mono text-[#36342E]">2026-03-24</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-[#6B6960]">License</span>
              <span className="text-sm text-[#36342E]">MIT</span>
            </div>
          </div>
        </div>
        <Divider />

        <SectionHeading>Links</SectionHeading>
        <div className="flex flex-col gap-1 py-2">
          {[
            { label: 'Documentation', href: 'https://www.autonomi.dev/docs' },
            { label: 'GitHub', href: 'https://github.com/asklokesh/loki-mode' },
            { label: 'Changelog', href: 'https://github.com/asklokesh/loki-mode/blob/main/CHANGELOG.md' },
            { label: 'Report a bug', href: 'https://github.com/asklokesh/loki-mode/issues/new' },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between px-3 py-2.5 rounded-lg text-sm text-[#36342E] hover:bg-[#FAF9F6] transition-colors group"
            >
              <span>{link.label}</span>
              <ExternalLink size={14} className="text-[#939084] group-hover:text-[#553DE9] transition-colors" />
            </a>
          ))}
        </div>
        <Divider />

        <SectionHeading>Updates</SectionHeading>
        <div className="py-3">
          <button
            type="button"
            onClick={() => {
              window.open('https://github.com/asklokesh/loki-mode/releases', '_blank');
            }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border border-[#553DE9] text-[#553DE9] hover:bg-[#E8E4FD] rounded-lg transition-colors"
          >
            Check for updates
          </button>
        </div>
      </div>
    );
  }

  // =========================================================================
  // Layout
  // =========================================================================

  return (
    <div className="flex h-full min-h-0">
      {/* Left sidebar - category navigation */}
      <nav
        className="w-56 flex-shrink-0 border-r border-[#ECEAE3] bg-[#FAF9F6] overflow-y-auto"
        aria-label="Settings categories"
      >
        <div className="px-4 py-5">
          <h1 className="font-heading text-lg font-bold text-[#36342E] mb-4">Settings</h1>
          <ul className="flex flex-col gap-0.5">
            {CATEGORIES.map((cat) => {
              const isActive = activeCategory === cat.id;
              return (
                <li key={cat.id}>
                  <button
                    type="button"
                    onClick={() => setActiveCategory(cat.id)}
                    className={[
                      'flex items-center gap-2.5 w-full px-3 py-2 text-sm rounded-lg transition-colors text-left',
                      isActive
                        ? 'bg-[#553DE9]/10 text-[#553DE9] font-medium'
                        : 'text-[#36342E] hover:bg-[#F8F4F0]',
                    ].join(' ')}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <cat.icon size={16} />
                    <span>{cat.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      {/* Right content area */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[640px] mx-auto px-8 py-6">
          <h2 className="font-heading text-base font-bold text-[#36342E] mb-1">
            {CATEGORIES.find((c) => c.id === activeCategory)?.label}
          </h2>
          <p className="text-xs text-[#6B6960] mb-6">
            {activeCategory === 'general' && 'Manage general application preferences'}
            {activeCategory === 'appearance' && 'Customize the look and feel of Purple Lab'}
            {activeCategory === 'editor' && 'Configure the code editor behavior and display'}
            {activeCategory === 'build' && 'Control build execution and automation settings'}
            {activeCategory === 'providers' && 'Configure AI provider connections and fallback chain'}
            {activeCategory === 'shortcuts' && 'View and manage keyboard shortcuts'}
            {activeCategory === 'accessibility' && 'Adjust accessibility and assistive technology options'}
            {activeCategory === 'about' && 'Version information and useful links'}
          </p>
          {renderContent()}
        </div>
      </main>
    </div>
  );
}
