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

## Static checks

Compilation fails, with grammar spans, on:

- duplicate rule/token names, or a rule named `word`
- unknown rules, tokens, or root
- unused rules and tokens (reachability from the root)
- left recursion, including indirect cycles
- repetitions or separated lists that can match nothing
- duplicate field labels in one tagged alternative

Ordered choice is allowed when first sets overlap. The compiler warns (not errors) when an earlier alternative is nullable, because later alternatives are then unreachable. Cuts and predicates are evaluated in order.

Diagnostics carry a code (`grammar/left-recursion`, `grammar/nullable-loop`, `grammar/unreachable-alternative`, `grammar/unused-rule`, and so on) and a span in the grammar file. A grammar with an error never produces a parser; warnings do not block compilation.

## Recovery

Only the root rule's declaration repetition recovers. On an item failure the parser:

1. reports the farthest expected set once;
2. skips from the item start to the next token in the item's sync set at delimiter depth zero;
3. forces progress and continues.

A cut inside the item does not suppress this recovery. Nested lists fail upward; the file survives. Malformed items are omitted from the tree rather than represented as error nodes.

## Typed ASTs

`generateTypes(file)` emits TypeScript interfaces for every tagged alternative and a union per rule. Tags are named `<Rule><Tag>Node` to keep same-named tags in different rules distinct. Precedence rules get `<Rule>BinaryNode`, `<Rule>PrefixNode`, and `<Rule>PostfixNode`.

```sh
node src/grammar/cli.ts gen examples/calc/calc.parl examples/calc/calc.ast.ts
```

Generated files are checked in so `tsc` sees them without a build step. `tests/grammar-types.test.ts` proves the generated shape matches parsed values.

## Self-hosting

`src/grammar/grammar.parl` is the grammar language written in itself. `tests/grammar.test.ts` parses it with the bootstrap parser, compiles that grammar, parses the same file with the compiled parser, and compares the two ASTs. Bootstrap only exists to break the cycle.
