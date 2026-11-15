// Generated from advanced.parl by `parlance source`. Do not edit.
export default `grammar Advanced

skip /\\s+/
skip /\\/\\/[^\\n]*/

word /[A-Za-z_][A-Za-z0-9_]*/
token Number /\\d+(?:\\.\\d+)?/
token String /"([^"\\\\\\n]|\\\\.)*"/

root File

rule File = {
  @file items:Item*
};

rule Item = {
  | Decl
  | Body
};

rule Decl = {
  | Import
  | DataDecl
};

rule Body = {
  @body expression:Expr
};

rule Import = {
  @import "import" specifier:$String ";"
};

rule DataDecl = {
  @type "type" name:Name parameters:TypeParameters? "=" constructors:sep1(Constructor, "|") ";"?
};

rule TypeParameters = {
  "(" values:sep1(Name, ",") ")"
};

rule Constructor = {
  @constructor name:Name fields:ConstructorFields?
};

rule ConstructorFields = {
  "(" values:sep1(TypeExpr, ",") ")"
};

rule TypeExpr = {
  | @forall "forall" parameters:Name+ "." body:TypeExpr
  | @arrow param:TypeAtom "->" result:TypeExpr
  | TypeAtom
};

rule TypeAtom = {
  | @typeRecord "{" fields:sep(TypeField, ",") "}"
  | @typeName name:Name arguments:TypeArguments?
  | "(" value:TypeExpr ")"
};

rule TypeArguments = {
  "(" values:sep1(TypeExpr, ",") ")"
};

rule TypeField = {
  @typeField name:Name ":" type:TypeExpr
};

rule Expr = precedence {
  left "==" | "!="
  left "<" | "<=" | ">" | ">="
  left "+" | "-"
  left "*" | "/"
  prefix "-" | "!"
  atom
    | Postfix
    | Base
};

rule Postfix = {
  @postfix base:Base operations:PostfixOperation+
};

rule PostfixOperation = {
  | @call arguments:Arguments
  | @field "." name:Name
};

rule Arguments = {
  "(" values:sep1(Expr, ",") ")"
};

rule Base = {
  | Let
  | Fn
  | If
  | Match
  | NumberLit
  | BooleanLit
  | StringLit
  | Record
  | Group
  | @name value:Name
};

rule NumberLit = {
  @number value:$Number
};

rule StringLit = {
  @string value:$String
};

rule BooleanLit = {
  | @true "true"
  | @false "false"
};

rule Record = {
  @record "{" fields:sep(RecordField, ",") base:RecordBase? "}"
};

rule RecordField = {
  @recordField name:Name "=" value:Expr
};

rule RecordBase = {
  "|" value:Expr
};

rule Group = {
  @group "(" value:Expr annotation:TypeAnnotation? ")"
};

rule TypeAnnotation = {
  ":" type:TypeExpr
};

rule Let = {
  @let "let" recursive:"rec"? name:Name annotation:TypeAnnotation? "=" value:Expr "in" body:Expr
};

rule Fn = {
  @fn "fn" "(" param:Name annotation:TypeAnnotation? ")" "=>" body:Expr
};

rule If = {
  @if "if" cond:Expr "then" then:Expr "else" else:Expr
};

rule Match = {
  @match "match" value:Expr "{" cases:sepEnd(MatchCase, ",") "}"
};

rule MatchCase = {
  @case pattern:Pattern "=>" body:Expr
};

rule Pattern = {
  @pattern name:Name fields:PatternFields?
};

rule PatternFields = {
  "(" values:sep1(Pattern, ",") ")"
};

rule Name = {
  word
};
`;
