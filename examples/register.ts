import { registerLanguages } from "../src/ts/loader.ts";
import { advanced } from "./advanced/advanced.ts";
import { calc } from "./calc/calc.ts";
import { machine } from "./machine/machine.ts";
import { schema } from "./schema/schema.ts";

registerLanguages([advanced, calc, machine, schema]);
