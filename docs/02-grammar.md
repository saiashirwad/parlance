# The grammar language

A `.parl` file defines a lexer and a parser. One file is the whole syntax description; there is no separate highlighter table.

```parl
grammar Calc

skip /\s+/
skip /\/\/[^\n]*/

word /[A-Za-z_][A-Za-z0-9_]*/
token Number /\d+(?:\.\d+)?/

root File

rule File = {
  @file declarations:Decl*
};

rule Decl = {
  | @let "let" ~ name:Name "=" value:Expr ";"
  | @show "show" value:Expr ";"
};

rule Expr = precedence {
  left "+" | "-"
  left "*" | "/"
  prefix "-"
  atom
    | @number value:$Number
    | @name value:Name
    | "(" value:Expr ")"
};

rule Name = { word };
```

## Declarations

| Form | Meaning |
| --- | --- |
| `grammar Name` | required, first declaration |
| `skip /pattern/` | trivia consumed between tokens; repeatable |
| `word /pattern/` | the identifier shape; optional, defaults to `[A-Za-z_][A-Za-z0-9_]*` |
| `token Name /pattern/` | a named terminal; optional `@highlight` maps it to an LSP token kind |
| `root Name` | the start rule; optional, defaults to the first rule |
| `rule Name = Body;` | a production |
| `bind { ... }` | declarative name binding over tagged nodes; optional, last; see [Name binding](#name-binding) |

A braced body (`= { ... };`) contains alternatives. A precedence body (`= precedence { ... };`) is described below. Semicolons terminate rules.

Token references use `$Name`; rule references are bare names. The two namespaces are separate, so `token Name` and `rule Name` can coexist.

## Expressions

| Syntax | Value produced |
| --- | --- |
| `"text"` | nothing, unless labeled |
| `/pattern/` | `Text` |
| `$Token` | `Text` |
| `word` | `Text` for any word, including words that are keywords elsewhere |
| `Rule` | that rule's value |
| `a b c` | one captured value, a tuple if several, `null` if none |
| `@tag a:Rule b:"x"` | `{ kind: "tag", a: ..., b: Text, span }` |
| `e*`, `e+`, `e?` | `readonly T[]`, non-empty `readonly T[]`, `T \| null` |
| `sep(e, ",")`, `sep1(e, ",")` | separated list, zero/one minimum |
| `sepEnd(e, ",")`, `sepEnd1(e, ",")` | trailing separator allowed |
| `&e`, `!e` | nothing; predicates |
| `~` | nothing; commit to this alternative |
| `( ... )` | grouped alternatives |

### What gets captured

Only values contribute to an untagged sequence. A literal contributes only when it has a label:

```parl
rule Boolean = { value:"true" | value:"false" };  // rule value: Text
rule Optional = { "("? value:Expr ")"? };          // "(" and ")" captured? no
```

`?`, `*`, `+`, and separated lists capture only when their operand captures. This is why `"|"?` contributes nothing, while `tag:Tag?` contributes `Text | null`.

A label always captures. Label `_` discards. In a tagged sequence only labels become fields; unlabeled values are parsed but dropped.

### Contextual keywords

The lexer emits words, not a separate keyword token class. A literal `"state"` matches a word token whose text is `state`. Therefore:

- `state` can be a keyword in one rule and a field name in another.
- the keyword set is inferred from identifier-shaped literals for highlighting only;
- a rule may be named `state` as long as the grammar does not use `"state"` as a literal before the reference in an ambiguous position.

Reserve nothing globally. Prefer distinct literal prefixes or a leading sigil when a grammar has many contextual words.

### Precedence

```parl
rule Expr = precedence {
  left "==" | "!="
  left "+" | "-"
  left "*" | "/"
  prefix "-" | "!"
  atom
    | @number value:$Number
    | @name value:Name
    | "(" value:Expr ")"
};
```

- Levels run low to high.
- `left`, `right`, `none`, `prefix`, and `postfix` are supported.
- Operators are expressions; a literal operator produces a `Text` with its source span.
- The parser builds `{ kind: "binary", operator, left, right, span }`, `{ kind: "prefix", operator, operand, span }`, or `{ kind: "postfix", operator, operand, span }`.
- `none` reports `operator cannot be chained; add parentheses` when the same level repeats.

### Tags are contextual

A tag names a node shape within its rule. Two rules can both use `@token` with different fields; generated types scope them per rule. A single rule cannot use the same tag with two different field sets without an explicit diagnostic, because a consumer switching on `kind` would lose precision.

## Name binding

A `bind` block says which labelled fields define names and which refer to them. It names nodes by tag and fields by label, as `tag.field`. `examples/machine/machine.parl`:

```parl
bind {
  import import.specifier
  builtin Int, String, Bool, DateTime: type "scalar"
  def machine.name: namespace
  export def event.name: event "event"
  def field.name: property "payload field" in event
  export def initial.name, state.name, final.name: class "state"
  ref transition.event: event
  ref transition.target: state
  ref field.type: scalar "payload type"
  unique transition.event in initial, state "State {owner} already handles {name}"
}
```

| Entry | Meaning |
| --- | --- |
| `def p: kind "label"` | each name in `p` is a definition of LSP `kind` (`variable`, `class`, ...). `"label"` is its namespace, the noun in "Duplicate ..." messages, and its detail; it defaults to `kind`. Hoisted: visible in the whole enclosing scope |
| `def p: kind after` | sequential: visible from the end of its node to the end of the scope (calc's `let`) |
| `def p: kind in tag.field` | visible only inside that field of the nearest `tag` node, the node itself included (`def fn.param: parameter in fn.body`) |
| `def p: kind in tag` | a member of the nearest enclosing `tag` node, not a lexical name; read back with `bound.members(node)` |
| `export def ...` | also listed in `bound.exports` |
| `ref p: label "noun"` | each name resolves to a visible `def` or `builtin` with that label, innermost scope first, else "Unknown noun" (noun defaults to the label) |
| `scope tag`, `scope tag.field` | that node, or that field, opens a lexical scope. The file is always one |
| `builtin A, B: kind "label"` | names in an outermost scope, with no source span. They also become completions |
| `unique p in tag, ...` | a name may appear once per nearest `tag` node; the optional message may use `{name}` and `{owner}` |
| `import p` | `p` holds import specifiers; `defineLanguage` uses it when the language gives no `imports` |

Duplicates are checked per scope across labels, so an event and a state cannot share a name. The checker runs it with `bind(file, cx, grammar.bind)`; see [Bind names declaratively](04-authoring.md#bind-names-declaratively).

## Static checks

Compilation fails, with grammar spans, on:

- duplicate rule/token names, or a rule named `word`
- unknown rules, tokens, or root
- unused rules and tokens (reachability from the root)
- left recursion, including indirect cycles
- repetitions or separated lists that can match nothing
- duplicate field labels in one tagged alternative
- in `bind`: an unknown tag or field, an unknown definition kind, or a `ref` label no `def` or `builtin` has (`grammar/bind`)

Ordered choice is allowed when first sets overlap. The compiler warns (not errors) when an earlier alternative is nullable, because later alternatives are then unreachable. Cuts and predicates are evaluated in order.

Diagnostics carry a code (`grammar/left-recursion`, `grammar/nullable-loop`, `grammar/unreachable-alternative`, `grammar/unused-rule`, and so on) and a span in the grammar file. A grammar with an error never produces a parser; warnings do not block compilation.

## Recovery

The strict parser runs first and is unchanged. When a root item fails, the parser reparses that item in repair mode. Repair keeps the item and fills in what is missing:

- A sequence commits after `~`, or after a matched literal that no later sibling alternative can also start with. Before it commits, a failure fails as usual, so ordered choice still works.
- A precedence expression commits after an operator, and a separated list after a separator.
- After a commit, a failed item skips tokens until one it can start with, or one in the sync set: what the enclosing sequences still expect (their remaining items' first tokens) plus the tokens that start a root item. A bracket group is skipped whole when it closes before such a token. A bare `word` does not take a keyword an enclosing sequence is still waiting for, so `let x = in` stops before `in`.
- A `*` or `+` list resumes after a skipped token: `model User { id: Int ) name: String }` keeps both fields.

Missing syntax gets a placeholder shaped like what the rule produces:

| missing | value |
| --- | --- |
| tagged node or precedence expression | `{ kind: "error", span }`, zero width |
| token | `{ text: "", span, missing: true }`, zero width |
| list | `[]` |
| optional | `null` |
| item of a separated list (`f(1, , 2)`) | left out of the list |

Diagnostics are `parse/missing` ("Expected ...", on the last character before the gap) and `parse/skipped` ("Unexpected ...", on the skipped tokens). The generated AST types include `ErrorNode` exactly in the unions that can hold one, so checkers must handle `kind: "error"` there; see [Handle error nodes](04-authoring.md#handle-error-nodes).

If repair fails too, the item is skipped as before: the farthest expected set is reported once (`parse/recover`) and the parser skips to the next token in the item's sync set at delimiter depth zero.

When the root loop stops on a token no item can start with, an earlier item probably settled for a shorter alternative (in `main.advanced`, `let a = 2 + in` used to end the file at the next `=`). The parser rolls back to the earliest accepted item whose failed alternatives looked at or past that token, reparses it in repair mode, and keeps the result if it gets past the stuck token. Otherwise the root ends there with `parse/unexpected`.

## Typed ASTs

`generateTypes(file)` emits TypeScript interfaces for every tagged alternative and a union per rule. Tags are named `<Rule><Tag>Node` to keep same-named tags in different rules distinct. Precedence rules get `<Rule>BinaryNode`, `<Rule>PrefixNode`, and `<Rule>PostfixNode`. Unions that repair can fill with an error node also include `ErrorNode`, and `Text` has an optional `missing: true`.

```sh
node src/grammar/cli.ts gen examples/calc/calc.parl examples/calc/calc.ast.ts
```

Generated files are checked in so `tsc` sees them without a build step. `tests/grammar-types.test.ts` proves the generated shape matches parsed values.

## Self-hosting

`src/grammar/grammar.parl` is the grammar language written in itself. `tests/grammar.test.ts` parses it with the bootstrap parser, compiles that grammar, parses the same file with the compiled parser, and compares the two ASTs. Bootstrap only exists to break the cycle. The `bind` block is in both parsers; a test checks that one parses to the same AST, spans included.
