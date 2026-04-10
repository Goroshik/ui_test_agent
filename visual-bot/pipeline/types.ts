// ─── Session & Step ───────────────────────────────────────────────────────────

export interface SessionMeta {
  sessionId: string;
  startedAt: string;
  task: string;
  baseUrl: string;
  status: 'running' | 'completed' | 'failed';
  steps: SessionStepSummary[];
}

export interface SessionStepSummary {
  stepId: string;
  stepIndex: number;
  action: string;
  description: string;
  url: string;
  status: 'complete' | 'incomplete';
}

export type ActionType = 'click' | 'fill' | 'navigate' | 'select' | 'hover' | 'press_key' | 'wait' | 'other';

export interface ActionElement {
  testid?: string | null;
  ariaRole?: string | null;
  ariaName?: string | null;
  tagName?: string | null;
  text?: string | null;
  bbox?: { x: number; y: number; width: number; height: number } | null;
  xpath?: string | null;
  cssPath?: string | null;
  ref?: string | null;
}

export interface ActionData {
  type: ActionType;
  description: string;
  element?: ActionElement;
  value?: string;
}

export interface ArtifactRefs {
  ariaSnapshotFile: string;
  domFile: string;
  storageFile: string;
  networkFile: string;
  screenshotFile: string;
}

export interface StorageDiff {
  added: Record<string, string>;
  changed: Record<string, { from: string; to: string }>;
  removed: Record<string, null>;
}

export interface AfterArtifacts {
  ariaSnapshotFile: string;
  screenshotFile?: string;
  storageFile?: string;
  networkFile?: string;
  storageDiff?: StorageDiff;
}

export interface StepRecord {
  stepId: string;
  stepIndex: number;
  timestamp: string;
  url: string;
  action: ActionData;
  before: ArtifactRefs | null;
  after: AfterArtifacts | null;
  status: 'complete' | 'incomplete';
}

// ─── Analyzed ─────────────────────────────────────────────────────────────────

export interface AriaComponent {
  ariaRole: string;
  ariaName: string;
  state: {
    disabled?: boolean;
    checked?: boolean | null;
    expanded?: boolean | null;
  };
  context: string;
  pageUrl: string;
  stepId: string;
}

export interface DomComponent {
  tagName: string;
  testid?: string | null;
  cssSelector?: string | null;
  id?: string | null;
  name?: string | null;
  type?: string | null;
  text?: string | null;
  ariaLabel?: string | null;
  pageUrl: string;
  stepId: string;
}

export interface NetworkTrigger {
  method: string;
  urlPattern: string;
  requestPayloadShape?: Record<string, string>;
  expectedStatus?: number;
  responseShape?: Record<string, string>;
}

export interface NetworkStepMap {
  stepId: string;
  triggers: NetworkTrigger[];
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export interface ComponentSelectors {
  preferred: string;
  aria: string;
  testid: string | null;
  css: string | null;
  xpath: string | null;
}

export interface ComponentAction {
  type: 'click' | 'fill' | 'select' | 'hover' | 'focus';
  value?: string;
  network?: {
    method: string;
    urlPattern: string;
    requestShape?: Record<string, unknown>;
    expectedStatus: number;
    responseShape?: Record<string, unknown>;
  };
  navigation?: {
    to: string;
    condition?: string;
  };
}

export interface ComponentRecord {
  id: string;
  label: string;
  componentType: string;
  pages: string[];
  lastSeen: string;
  selectors: ComponentSelectors;
  actions: ComponentAction[];
  states: {
    disabled_when?: string;
    hidden_when?: string;
    loading_after?: string;
    variants?: string[];
  };
  assertions: {
    pre_interaction: string[];
    post_interaction: string[];
  };
  confidence: 'high' | 'medium' | 'low';
  seenCount: number;
  manualOverride: boolean;
  notes: string;
}

export interface ComponentRegistry {
  version: string;
  lastUpdated: string;
  components: Record<string, ComponentRecord>;
}

export interface PageRegistry {
  [urlPath: string]: {
    title: string;
    components: string[];
    lastSeen: string;
  };
}
