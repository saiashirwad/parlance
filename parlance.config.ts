import { advanced } from "./examples/advanced/advanced.ts";
import { calc } from "./examples/calc/calc.ts";
import { machine } from "./examples/machine/machine.ts";
import { schema } from "./examples/schema/schema.ts";
import { shade } from "./examples/shade/shade.ts";
import { grammarLanguage } from "./src/grammar/language.ts";

export default { languages: [advanced, calc, machine, schema, shade, grammarLanguage] };
