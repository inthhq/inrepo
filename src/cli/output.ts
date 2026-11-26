/**
 * Output mode for humans vs. agents.
 *
 * Under `--json`, stdout carries exactly one JSON document (the result
 * envelope) and nothing else. Every other write to stdout (banners, spinners,
 * hexbus logger lines, `console.log`) is redirected to stderr so existing
 * human-oriented code paths keep working without corrupting the payload.
 *
 * Outside `--json`, the decorative banner is skipped whenever stdout is not a
 * TTY or a known agent/CI environment is detected.
 */

import type { ErrorPayload } from "./errors.js";

/** Bump only on breaking changes to the envelope or a command's `data`. */
export const JSON_SCHEMA_VERSION = 1;

export interface SuccessEnvelope<T> {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  ok: true;
  command: string;
  dryRun?: boolean;
  data: T;
}

export interface FailureEnvelope<T = null> {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  ok: false;
  command: string;
  error: ErrorPayload;
  /** Partial command data when the failure still produced useful state. */
  data?: T;
}

interface OutputState {
  json: boolean;
  dryRun: boolean;
  emitted: boolean;
  rawStdoutWrite?: typeof process.stdout.write;
  rawConsoleLog?: typeof console.log;
  rawConsoleInfo?: typeof console.info;
}

const state: OutputState = { dryRun: false, emitted: false, json: false };

/** Env vars that indicate an AI coding agent or CI runner is driving the CLI. */
const AGENT_ENV_VARS = [
  "CI",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CODEX_SANDBOX",
  "CODEX_HOME",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "AIDER_MODEL",
  "INREPO_AGENT",
] as const;

export const isAgentEnvironment = function isAgentEnvironment(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return AGENT_ENV_VARS.some((key) => {
    const value = env[key];
    return (
      value !== undefined && value !== "" && value !== "0" && value !== "false"
    );
  });
};

/** Undo the `--json` stdout/console redirection, if active. */
const restoreStdout = function restoreStdout(): void {
  if (state.rawStdoutWrite !== undefined) {
    process.stdout.write = state.rawStdoutWrite;
  }
  if (state.rawConsoleLog !== undefined) {
    console.log = state.rawConsoleLog;
  }
  if (state.rawConsoleInfo !== undefined) {
    console.info = state.rawConsoleInfo;
  }
  state.rawStdoutWrite = undefined;
  state.rawConsoleLog = undefined;
  state.rawConsoleInfo = undefined;
};

/**
 * Configure output once per process, before any command output. Under
 * `json`, stdout writes are rerouted to stderr until `emitJson` runs.
 */
export const configureOutput = function configureOutput(options: {
  json: boolean;
  dryRun: boolean;
}): void {
  if (!options.json) {
    restoreStdout();
  }
  state.json = options.json;
  state.dryRun = options.dryRun;
  if (options.json && state.rawStdoutWrite === undefined) {
    const raw = process.stdout.write.bind(process.stdout);
    state.rawStdoutWrite = raw;
    // SAFETY: stderr.write has the same overloads as stdout.write.
    process.stdout.write = process.stderr.write.bind(
      process.stderr
    ) as typeof process.stdout.write;
    // Bun's console.log writes to fd 1 directly, bypassing stdout.write.
    state.rawConsoleLog = console.log;
    state.rawConsoleInfo = console.info;
    console.log = console.error;
    console.info = console.error;
  }
};

export const isJsonMode = function isJsonMode(): boolean {
  return state.json;
};

export const isDryRun = function isDryRun(): boolean {
  return state.dryRun;
};

/** True when decorative output (ASCII banner) should be printed. */
export const shouldDecorate = function shouldDecorate(): boolean {
  return !state.json && process.stdout.isTTY === true && !isAgentEnvironment();
};

const writeJson = function writeJson<T>(
  value: FailureEnvelope<T> | SuccessEnvelope<T>
): void {
  const write =
    state.rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
  write(`${JSON.stringify(value, null, 2)}\n`);
  state.emitted = true;
};

/** Emit the success envelope. No-op outside `--json` or if already emitted. */
export const emitResult = function emitResult<T>(
  command: string,
  data: T
): void {
  if (!state.json || state.emitted) {
    return;
  }
  const envelope: SuccessEnvelope<T> = {
    command,
    data,
    ok: true,
    schemaVersion: JSON_SCHEMA_VERSION,
  };
  if (state.dryRun) {
    envelope.dryRun = true;
  }
  writeJson(envelope);
};

/** Emit the failure envelope. No-op outside `--json` or if already emitted. */
export const emitFailure = function emitFailure<T = null>(
  command: string,
  error: ErrorPayload,
  data?: T
): void {
  if (!state.json || state.emitted) {
    return;
  }
  const envelope: FailureEnvelope<T> = {
    command,
    error,
    ok: false,
    schemaVersion: JSON_SCHEMA_VERSION,
  };
  if (data !== undefined) {
    envelope.data = data;
  }
  writeJson(envelope);
};

/** Test-only: reset module state between in-process tests. */
export const resetOutputForTests = function resetOutputForTests(): void {
  restoreStdout();
  state.json = false;
  state.dryRun = false;
  state.emitted = false;
};
