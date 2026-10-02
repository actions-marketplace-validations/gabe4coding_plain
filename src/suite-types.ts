import type { TestResult } from './runner.js';
import type { Status, StepResult } from './results.js';
import type { LoadOptions } from './spec.js';

/** One execution of one spec. */
export type AttemptResult = TestResult;
export type Engine = 'browser' | 'desktop' | 'mobile';
export interface Artifact { kind: 'screenshot' | 'trace' | 'dump'; path: string; step?: number }
export interface Attempt extends AttemptResult {
  attempt: number; durationMs: number; artifacts: Artifact[];
  /** `${error}` when `engine.run` threw (hooks module missing, browser launch failed, ...): no steps ran. */
  error?: string;
}
export interface SpecReport {
  file: string;
  name: string;
  tags: string[];
  status: Status;
  flaky: boolean;
  attempts: Attempt[];
  loadError?: string;
  skipReason?: 'bail' | 'max-tokens';
}
export interface RunReport {
  engine: Engine;
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
  specs: SpecReport[];
  totals: { jevCalls: number; tokens: number; passed: number; failed: number; flaky: number; skipped: number };
  stopped?: 'bail' | 'max-tokens';
  status: 'pass' | 'fail';
}
export interface CaptureTarget {
  engine: Engine;
  /** Attached browser context: tracing would also record the user's other tabs. */
  cdp?: boolean;
  screenshot(file: string): Promise<void>;
  page?(): import('playwright').Page;
}
export interface SpecInfo { file: string; name: string; tags: string[]; attempt: number }
export interface RunObserver {
  runStart?(e: { engine: Engine; specs: { file: string; name: string; tags: string[] }[] }): Promise<void>;
  /** The target can be captured; fires before the first step. Browser: right after the context opens, before setup
   *  hooks. Desktop/mobile: after setup hooks and `open()` (setup may choose the app or device). `stepEnd` fires only
   *  after it, and `sessionClose` only when it fired. */
  sessionOpen?(e: SpecInfo & { target: CaptureTarget }): Promise<void>;
  stepEnd?(e: SpecInfo & { index: number; result: StepResult; target: CaptureTarget }): Promise<void>;
  sessionClose?(e: SpecInfo & { status: Status; target: CaptureTarget }): Promise<Artifact[]>;
  specEnd?(e: { report: SpecReport }): Promise<void>;
  runEnd?(e: { report: RunReport }): Promise<void>;
}
export interface SuiteEngine<S> {
  engine: Engine;
  load(file: string, opts?: LoadOptions): S;
  meta(spec: S): { name: string; tags: string[]; timeoutMs?: number };
  run(spec: S, observer: RunObserver | undefined, info: SpecInfo): Promise<AttemptResult>;
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
  artifacts?: { dir: string; screenshot: 'off' | 'on-failure' | 'always'; trace: 'off' | 'on-failure' | 'always' };
  specTimeout?: number;
}
export type EngineFlags = Record<string, string | boolean | undefined>;
