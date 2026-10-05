import type { Page } from 'playwright';
import type { Status, StepResult, TestResult } from '../core/results.js';
import type { LoadOptions } from '../core/spec.js';
import type { LockAttempt, RunMode } from '../core/lock.js';

export type Engine = 'browser' | 'desktop' | 'mobile';
export type StopReason = 'bail' | 'max-tokens';
export const CAPTURE_MODES = ['off', 'on-failure', 'always'] as const;
export type CaptureMode = typeof CAPTURE_MODES[number];

export interface Artifact { kind: 'screenshot' | 'trace' | 'dump'; path: string; step?: number }

/** One execution of one spec. */
export interface Attempt extends TestResult {
  attempt: number;
  durationMs: number;
  artifacts: Artifact[];
  /** `${error}` when `engine.run` threw (hooks module missing, browser launch failed...): no steps ran. */
  error?: string;
}

export interface SpecReport {
  file: string;
  name: string;
  tags: string[];
  status: Status;
  /** Passed on a retry; counts as a pass. */
  flaky: boolean;
  attempts: Attempt[];
  loadError?: string;
  skipReason?: StopReason;
}

export interface RunReport {
  engine: Engine;
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
  specs: SpecReport[];
  totals: { jevCalls: number; tokens: number; passed: number; failed: number; flaky: number; skipped: number; replayed: number; healed: number };
  stopped?: StopReason;
  status: 'pass' | 'fail';
}

/** What an observer can capture: a screenshot, and for the browser the page (for tracing). */
export interface CaptureTarget {
  engine: Engine;
  /** An attached browser context: tracing would also record the user's other tabs. */
  cdp?: boolean;
  screenshot(file: string): Promise<void>;
  page?(): Page;
}

export interface SpecInfo {
  file: string;
  name: string;
  tags: string[];
  attempt: number;
  /** This attempt's lock, from the suite; the engine takes it off before observers see the info. */
  lock?: LockAttempt;
}

export interface RunObserver {
  runStart?(event: { engine: Engine; specs: { file: string; name: string; tags: string[] }[] }): Promise<void>;
  /**
   * The target can be captured; fires before the first step. Browser: right after the context opens, before
   * setup. Desktop and mobile: after setup and `open()`, since setup may choose the app or the device. `stepEnd`
   * fires only after it, and `sessionClose` only when it fired.
   */
  sessionOpen?(event: SpecInfo & { target: CaptureTarget }): Promise<void>;
  stepEnd?(event: SpecInfo & { index: number; result: StepResult; target: CaptureTarget }): Promise<void>;
  sessionClose?(event: SpecInfo & { status: Status; target: CaptureTarget }): Promise<Artifact[]>;
  specEnd?(event: { report: SpecReport }): Promise<void>;
  runEnd?(event: { report: RunReport }): Promise<void>;
}

/** What each engine gives the shared suite runner. */
export interface SuiteEngine<S> {
  engine: Engine;
  load(file: string, opts?: LoadOptions): S;
  meta(spec: S): { name: string; tags: string[]; timeoutMs?: number };
  run(spec: S, observer: RunObserver | undefined, info: SpecInfo): Promise<TestResult>;
  maxWorkers: number;
  close?(): Promise<void>;
}

export interface Loaded<S> { file: string; spec: S; name: string; tags: string[]; timeoutMs?: number }

export interface ReporterSpec { name: string; output?: string }

export interface SuiteOptions {
  files: string[];
  workers: number;
  retries: number;
  bail: number;
  lastFailed: boolean;
  maxTokens?: number;
  grep?: string;
  grepInvert?: string;
  tags: string[];
  list: boolean;
  reporters: ReporterSpec[];
  timing: boolean;
  artifacts?: { dir: string; screenshot: CaptureMode; trace: CaptureMode };
  specTimeout?: number;
  /** judge, no-judge or auto-healing (src/core/lock.ts). */
  mode?: RunMode;
}

export type EngineFlags = Record<string, string | boolean | undefined>;
