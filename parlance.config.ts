import { calc } from "./examples/calc/calc.ts";
import { machine } from "./examples/machine/machine.ts";
import { schema } from "./examples/schema/schema.ts";
import { grammarLanguage } from "./src/grammar/language.ts";

export default { languages: [calc, machine, schema, grammarLanguage] };
