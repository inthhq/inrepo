export type CliCommand = {
  name: string;
  description: string;
  hidden?: boolean;
};
export type CliFlag = {
  names: string[];
  description: string;
  expectsValue: boolean;
};

export type CliContext = {
  logger: {
    debug(message: string): void;
    note(message: string, title: string): void;
  };
};
