/**
 * Driver = the thing that actually pokes at the app under test.
 * Two implementations: web (via Vercel's agent-browser CLI) and mobile
 * (via the existing hma_automation Appium runner). Both expose the same
 * snapshot/act surface so the agent loop is platform-agnostic.
 */

/** A single interactive element from the page/screen, identified by a stable ref. */
export interface SnapshotElement {
  ref: string;        // e.g. "@e1" — opaque, supplied by the driver
  role: string;       // "button" | "textbox" | "link" | "checkbox" | ...
  name?: string;      // accessible name / label / inner text
  value?: string;     // current value, for inputs
  description?: string; // any extra hint the driver surfaces
}

export interface Snapshot {
  url?: string;       // for web
  title?: string;
  elements: SnapshotElement[];
  /** Raw textual snapshot, useful when the LLM needs more context than the structured view. */
  raw: string;
}

export interface ActionResult {
  ok: boolean;
  /** Human-readable detail (selector that worked, error if failed). */
  detail?: string;
}

export type Action =
  | { type: "open"; url: string }
  | { type: "click"; ref: string }
  | { type: "fill"; ref: string; text: string }
  | { type: "select"; ref: string; option: string }
  | { type: "check"; ref: string }
  | { type: "press"; key: string }
  | { type: "scroll"; direction: "up" | "down"; pixels?: number }
  | { type: "wait"; ms?: number; refOrUrl?: string }
  | { type: "get_text"; ref: string }
  | { type: "screenshot"; path: string; fullPage?: boolean };

export interface Driver {
  /** Initialise the driver (launch browser / connect to device). */
  start(): Promise<void>;

  /** Navigate to / open a starting URL or app. */
  open(target: string): Promise<void>;

  /** Snapshot the current page/screen — the LLM uses this to choose actions. */
  snapshot(): Promise<Snapshot>;

  /** Execute one action; returns ok + detail. */
  act(action: Action): Promise<ActionResult>;

  /** Capture a screenshot to disk (PNG). Returns the absolute path. */
  screenshot(filePath: string, fullPage?: boolean): Promise<string>;

  /** Tear down. */
  close(): Promise<void>;
}
