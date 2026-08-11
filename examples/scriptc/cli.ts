// Variant A: dependencies resolved from npm (node_modules), like the scriptc
// quickstart example: https://scriptc.dev/quickstart#use-an-npm-dependency
import { Command } from "commander";
import pc from "picocolors";

const program = new Command();

program.name("demo");
program.description("Tiny terminal app: commander + picocolors");
program.version("0.0.0");

program
  .command("greet")
  .argument("[name]", "who to greet", "world")
  .option("-u, --upper", "shout the name")
  .option("-r, --repeat <count>", "repeat the greeting", "1")
  .action((name: string, opts: { upper?: boolean; repeat: string }) => {
    const { bold, green, cyan } = pc;
    const who = opts.upper ? name.toUpperCase() : name;
    const count = parseInt(opts.repeat, 10) || 1;
    for (let i = 0; i < count; i++) {
      console.log(`${bold(green("✔"))} hello, ${cyan(who)}!`);
    }
  });

program.parse(process.argv);
