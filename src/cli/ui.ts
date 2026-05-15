import {
  createCliLogger,
  createSpinner,
  promptConfirm,
  promptSelect,
  promptText,
} from 'hexbus';

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

export async function text(options: {
  message: string;
  placeholder?: string;
  validate?: (value: string | undefined) => string | undefined;
}): Promise<string | PromptCancelled> {
  const answer = await promptText({
    cancel: 'silent',
    message: options.message,
    placeholder: options.placeholder,
    validate: options.validate,
  });
  return answer ?? CANCELLED;
}

export async function confirm(options: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean | PromptCancelled> {
  const answer = await promptConfirm({
    cancel: 'silent',
    message: options.message,
    initialValue: options.initialValue,
  });
  return answer ?? CANCELLED;
}

export async function select<T extends string>(options: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValue?: T;
}): Promise<T | PromptCancelled> {
  const answer = await promptSelect({
    cancel: 'silent',
    message: options.message,
    options: options.options,
    initialValue: options.initialValue,
  });
  return answer ?? CANCELLED;
}
