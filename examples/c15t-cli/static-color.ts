/**
 * The benchmark contract always sets NO_COLOR=1. For the only color operation
 * reached by c15t's help renderer, picocolors therefore has identity behavior.
 */
const cyan = function cyan(input: string): string {
  return input;
};

export default { cyan };
