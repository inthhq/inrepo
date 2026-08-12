// Dynamic reference: exact selected c15t source retains its bare picocolors
// import, so scriptc executes that npm dependency through the dynamic runtime.
import { showHelpMenu } from "./generated/dynamic/show-help-menu.ts";
import { commands, context, flags, VERSION } from "./help-fixture.ts";

showHelpMenu(context, VERSION, commands, flags);
