import { registerLanguages } from "../src/ts/loader.ts";
import { calc } from "./calc/calc.ts";

registerLanguages([calc]);
