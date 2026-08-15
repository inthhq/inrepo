export interface CliCommand {
  name: string;
  description: string;
  hidden?: boolean;
}
export interface CliFlag {
  names: string[];
  description: string;
  expectsValue: boolean;
}

export interface CliContext {
  logger: {
    debug: (message: string) => void;
    note: (message: string, title: string) => void;
  };
}
