# advanced

A small functional language for the parts of a program that are mostly data and pattern matching. It is the port of the old `langkit` `.advanced` example to the `parlance` language value.

## Shape

A file declares types, then ends with one expression:

```advanced
type Tree(a) = Leaf(a) | Branch(Tree(a), Tree(a))

let rec sumTree = fn(tree) => match tree {
  Leaf(value) => value,
  Branch(left, right) => sumTree(left) + sumTree(right)
} in

sumTree(Branch(Leaf(1), Leaf(2)))
```

A file can import another `.advanced` file. The imported file's body must be a closed record; its fields become the module's values:

```advanced
import "./stdlib.advanced";

type Tree(a) = Leaf(a) | Branch(Tree(a), Tree(a))

let fromList = fn(first) => fn(rest) =>
  foldList(fn(tree) => fn(value) => Branch(tree, Leaf(value)))(Leaf(first))(rest) in

{
  fromList = fromList
}
```

## What the checker does

- infers `number`, `boolean`, `string`, functions, open and closed records, and user data types
- generalizes `let` bindings and instantiates them at every use
- accepts explicit `forall` annotations and checks higher-rank arguments
- rejects skolem escape and impredicative inference
- checks constructor arity, duplicate cases, and match exhaustiveness
- infers record rows and rejects duplicate fields
- reports exports whose inferred type cannot be represented in TypeScript

`type ...` is recursive. `let rec` requires a function initializer. Patterns are constructor patterns with binding or `_` fields; nested patterns are rejected explicitly.

## Hosts

The TypeScript surface emits one invariant brand per data type, generic constructor and value signatures, and cross-file type imports. For example, `trees.advanced` produces:

```ts
import type { List } from "./stdlib.advanced";

declare const $Tree: unique symbol;
export type Tree<A> = { readonly [$Tree]: (x: readonly [A]) => readonly [A] };
export declare const Leaf: <A>(x: A) => Tree<A>;
export declare const Branch: <A>(x: Tree<A>) => (x: Tree<A>) => Tree<A>;
export declare const fromList: <A>(x: A) => (x: List<A>) => Tree<A>;
```

The runtime is emitted JavaScript: constructors are curried tagged records, a `match` compiles to a `switch`, and a module exports each record field and every constructor. The Node loader imports `.advanced` files like any other module.

```sh
./parlance check examples/advanced/main.advanced
node --import ./examples/register.ts examples/typescript/advanced.ts
```

## Limits

- Nested constructor patterns are rejected.
- Polymorphic record fields and polymorphic data arguments are rejected.
- Binary operators are numeric, as in the upstream example; `==` and comparisons do not accept strings.
- Nullary constructor declarations use `any` for their type parameter in TypeScript because a `const` cannot be generic.
- There are no emit targets yet.
