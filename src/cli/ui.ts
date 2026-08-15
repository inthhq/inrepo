import {
  createCliLogger,
  createSpinner,
  promptConfirm,
  promptSelect,
  promptText,
} from "hexbus";

const CANCELLED = Symbol("cancelled");

export type PromptCancelled = typeof CANCELLED;

export const ui = createCliLogger("info");

export const intro = function intro(message: string): void {
  ui.message(message);
};

export const outro = function outro(message: string): void {
  ui.outro(message);
};

export const cancel = function cancel(message: string): void {
  ui.outro(message);
};

export const error = function error(message: string): void {
  console.error(message);
};

export const warn = function warn(message: string): void {
  console.error(message);
};

export const isCancel = function isCancel(
  value: PromptCancelled | boolean | string
): value is PromptCancelled {
  return value === CANCELLED;
};

export const spinner = function spinner(): ReturnType<typeof createSpinner> & {
  error: (message: string) => void;
} {
  const s = createSpinner();
  return {
    ...s,
    error(message: string) {
      s.stop(message);
    },
  };
};

export const text = async function text(options: {
  message: string;
  placeholder?: string;
  validate?: (value: string | undefined) => string | undefined;
}): Promise<string | PromptCancelled> {
  const answer = await promptText({
    cancel: "silent",
    message: options.message,
    placeholder: options.placeholder,
    validate: options.validate,
  });
  return answer ?? CANCELLED;
};

export const confirm = async function confirm(options: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean | PromptCancelled> {
  const answer = await promptConfirm({
    cancel: "silent",
    initialValue: options.initialValue,
    message: options.message,
  });
  return answer ?? CANCELLED;
};

export const select = async function select<T extends string>(options: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValue?: T;
}): Promise<T | PromptCancelled> {
  const answer = await promptSelect({
    cancel: "silent",
    initialValue: options.initialValue,
    message: options.message,
    options: options.options,
  });
  return answer ?? CANCELLED;
};
