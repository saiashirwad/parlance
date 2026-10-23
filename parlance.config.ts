import { advanced } from "./examples/advanced/advanced.ts";
import { calc } from "./examples/calc/calc.ts";
import { machine } from "./examples/machine/machine.ts";
import { schema } from "./examples/schema/schema.ts";
import { grammarLanguage } from "./src/grammar/language.ts";

export default { languages: [advanced, calc, machine, schema, grammarLanguage] };
