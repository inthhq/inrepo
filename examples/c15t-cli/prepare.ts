import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

const SOURCE = nodePath.join(
  import.meta.dir,
  "vendor",
  "inrepo_modules",
  "@c15t",
  "cli",
  "src",
  "actions",
  "show-help-menu.ts"
);
const EXPECTED_SHA256 =
  "c2c631683cb50913e8afa2102dd030d1dfa5aee67559904a7ddac98e26d6c1e1";
const TYPE_IMPORT =
  "import type { CliCommand, CliContext, CliFlag } from '~/context/types'; // Import both types";
const HARNESS_TYPE_IMPORT =
  'import type { CliCommand, CliContext, CliFlag } from "../../harness-types.ts";';

let source: string;
try {
  source = await readFile(SOURCE, "utf-8");
} catch {
  throw new Error(
    `Missing ${SOURCE}. Run \`npm run sync\` from examples/c15t-cli first.`
  );
}
const actualHash = createHash("sha256").update(source).digest("hex");
if (actualHash !== EXPECTED_SHA256) {
  throw new Error(
    `Selected c15t help source changed: expected ${EXPECTED_SHA256}, received ${actualHash}`
  );
}
if (!source.includes(TYPE_IMPORT)) {
  throw new Error(
    "Selected c15t help source no longer contains its type import"
  );
}

const common = source
  .replace(TYPE_IMPORT, HARNESS_TYPE_IMPORT)
  .replace(
    "const commandColumnWidth =\n\t\tMath.max(...visibleCommands.map((cmd) => cmd.name.length), 10) + 2;",
    "const commandWidths = visibleCommands.map((cmd) => cmd.name.length);\n\tcommandWidths.push(10);\n\tconst commandColumnWidth = Math.max(...commandWidths) + 2;"
  )
  .replace(
    "const optionColumnWidth =\n\t\tMath.max(...flagDisplays.map((flag) => flag.length), 20) + 2;",
    "const optionWidths = flagDisplays.map((flag) => flag.length);\n\toptionWidths.push(20);\n\tconst optionColumnWidth = Math.max(...optionWidths) + 2;"
  );
if (common === source.replace(TYPE_IMPORT, HARNESS_TYPE_IMPORT)) {
  throw new Error("The scriptc Math.max compatibility patch did not apply");
}
const variants = {
  dynamic: common,
  static: common.replace(
    "import color from 'picocolors';",
    'import color from "../../static-color.ts";'
  ),
};

for (const [name, contents] of Object.entries(variants)) {
  const outputDir = nodePath.join(import.meta.dir, "generated", name);
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    nodePath.join(outputDir, "show-help-menu.ts"),
    contents,
    "utf-8"
  );
}

console.log(`Selected @c15t/cli@2.2.0 help source (${actualHash}).`);
