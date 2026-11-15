import { registerLanguages } from "../src/ts/loader.ts";
import { advanced } from "./advanced/advanced.ts";
import { calc } from "./calc/calc.ts";
import { machine } from "./machine/machine.ts";
import { schema } from "./schema/schema.ts";
import { shade } from "./shade/shade.ts";

registerLanguages([advanced, calc, machine, schema, shade]);
