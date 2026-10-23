import { registerLanguages } from "../src/ts/loader.ts";
import { calc } from "./calc/calc.ts";
import { machine } from "./machine/machine.ts";
import { schema } from "./schema/schema.ts";

registerLanguages([calc, machine, schema]);
