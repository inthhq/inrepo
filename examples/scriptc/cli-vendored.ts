import { isString } from "../../src/json/unknown.js";
// Variant B: dependencies vendored into the repo with inrepo.
// The imports point at the pinned upstream source in inrepo_modules/ —
// no node_modules involved. scriptc compiles this source like any other
// file in the project (statically — no embedded JS engine).
//
// Note: the static build reads positional args and options via typed
// accessors (processedArgs / opts()) instead of action-callback parameters —
// see the action() patch in inrepo_modules/commander.
import { Command } from "./inrepo_modules/commander/index.js";
import { bold, cyan, green } from "./inrepo_modules/picocolors/picocolors.js";

const program = new Command();

program.name("demo");
program.description("Tiny terminal app: commander + picocolors");
program.version("0.0.0");

const greet = program.command("greet");
greet.argument("[name]", "who to greet", "world");
greet.option("-u, --upper", "shout the name");
greet.option("-r, --repeat <count>", "repeat the greeting", "1");
greet.action(() => {
  const rawName =
    greet.processedArgs.length > 0 ? greet.processedArgs[0] : "world";
  const opts = greet.opts();
  const upper = opts.upper === true;
  const repeatRaw = opts.repeat;

  const name = isString(rawName) ? rawName : "world";
  const repeat = isString(repeatRaw) ? repeatRaw : "1";
  const who = upper ? name.toUpperCase() : name;
  const count = Math.trunc(Number(repeat)) || 1;
  for (let i = 0; i < count; i += 1) {
    console.log(`${bold(green("✔"))} hello, ${cyan(who)}!`);
  }
});

program.parse(process.argv);
