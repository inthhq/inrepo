import { createCliLogger, createSpinner } from 'hexbus';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const CANCELLED = Symbol('cancelled');

export type PromptCancelled = typeof CANCELLED;

export const ui = createCliLogger('info');

export function intro(message: string): void {
  ui.message(message);
}

export function outro(message: string): void {
  ui.outro(message);
}

export function cancel(message: string): void {
  ui.outro(message);
}

export function error(message: string): void {
  console.error(message);
}

export function warn(message: string): void {
  console.error(message);
}

export function isCancel(value: unknown): value is PromptCancelled {
  return value === CANCELLED;
}

export function spinner(): ReturnType<typeof createSpinner> & { error(message: string): void } {
  const s = createSpinner();
  return {
    ...s,
    error(message: string) {
      s.stop(message);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function ask(question: string): Promise<string | PromptCancelled> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } catch (e) {
    if (isAbortError(e)) return CANCELLED;
    throw e;
  } finally {
    rl.close();
  }
}

export async function text(options: {
  message: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string | PromptCancelled> {
  const hint = options.placeholder ? ` (${options.placeholder})` : '';
  while (true) {
    const answer = await ask(`${options.message}${hint}: `);
    if (isCancel(answer)) return answer;

    const validation = options.validate?.(answer);
    if (!validation) return answer;
    error(validation);
  }
}

export async function confirm(options: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean | PromptCancelled> {
  const defaultValue = options.initialValue ?? true;
  const suffix = defaultValue ? 'Y/n' : 'y/N';

  while (true) {
    const answer = await ask(`${options.message} (${suffix}) `);
    if (isCancel(answer)) return answer;

    const normalized = answer.trim().toLowerCase();
    if (normalized === '') return defaultValue;
    if (normalized === 'y' || normalized === 'yes') return true;
    if (normalized === 'n' || normalized === 'no') return false;
    error('Please answer yes or no.');
  }
}

export async function select<T extends string>(options: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValue?: T;
}): Promise<T | PromptCancelled> {
  const initialIndex = Math.max(
    0,
    options.options.findIndex((option) => option.value === options.initialValue),
  );

  ui.message(options.message);
  for (const [index, option] of options.options.entries()) {
    const hint = option.hint ? ` - ${option.hint}` : '';
    ui.message(`  ${index + 1}. ${option.label}${hint}`);
  }

  while (true) {
    const answer = await ask(`Choose [${initialIndex + 1}]: `);
    if (isCancel(answer)) return answer;

    const trimmed = answer.trim();
    if (trimmed === '') return options.options[initialIndex]?.value ?? CANCELLED;

    const choice = Number.parseInt(trimmed, 10);
    const selected = options.options[choice - 1];
    if (Number.isInteger(choice) && selected) return selected.value;
    error(`Enter a number from 1 to ${options.options.length}.`);
  }
}
