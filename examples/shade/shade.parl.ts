// Generated from shade.parl by `parlance source`. Do not edit.
export default `grammar Shade

skip /\\s+/
skip /\\/\\/[^\\n]*/

word /[A-Za-z_][A-Za-z0-9_]*/
token Number /(?:0[xX][0-9a-fA-F]+|\\d+\\.\\d+(?:[eE][+-]?\\d+)?|\\d+[eE][+-]?\\d+|\\d+)[iuf]?/

root File

rule File = {
  @file items:Item*
};

rule Item = {
  | Struct
  | Resource
  | Fn
  | Compute
};

rule Struct = {
  @struct "struct" ~ name:Name "{" fields:sepEnd(Field, ",") "}"
};

rule Field = {
  @field attrs:Attr* name:Name ":" type:Type
};

rule Attr = {
  @attr "@" ~ name:Name "(" args:sep1($Number, ",") ")"
};

rule Resource = {
  @resource attrs:Attr* space:Space ~ name:Name ":" type:Type ";"
};

rule Space = {
  | @uniform "uniform"
  | @storage "storage" access:Access?
};

rule Access = {
  | value:"read_write"
  | value:"read"
};

rule Fn = {
  @fn "fn" ~ name:Name "(" params:sepEnd(Param, ",") ")" result:Result? body:Block
};

rule Result = {
  "->" type:Type
};

rule Param = {
  @param name:Name ":" type:Type
};

rule Compute = {
  @compute "compute" ~ name:Name "[" size:sep1($Number, ",") "]" body:Block
};

rule Type = {
  | @arrayType "array" "<" ~ element:Type count:Count? ">"
  | @typeName name:Name
};

rule Count = {
  "," value:$Number
};

rule Block = {
  @block "{" ~ statements:Stmt* "}"
};

rule Stmt = {
  | @let "let" ~ name:Name annotation:Annotation? "=" value:Expr ";"
  | @var "var" ~ name:Name annotation:Annotation? init:Init? ";"
  | @return "return" ~ value:Expr? ";"
  | If
  | @while "while" ~ cond:Expr body:Block
  | @for "for" ~ name:Name "in" from:Expr ".." to:Expr body:Block
  | @break "break" ~ ";"
  | @continue "continue" ~ ";"
  | Block
  | @assign target:Expr op:AssignOp ~ value:Expr ";"
  | @expr value:Expr ";"
};

rule If = {
  @if "if" ~ cond:Expr then:Block otherwise:Else?
};

rule Else = {
  @else "else" ~ branch:Branch
};

rule Branch = {
  | If
  | Block
};

rule Annotation = {
  ":" type:Type
};

rule Init = {
  "=" value:Expr
};

rule AssignOp = {
  | value:"="
  | value:"+="
  | value:"-="
  | value:"*="
  | value:"/="
};

rule Expr = precedence {
  left "||"
  left "&&"
  none "==" | "!=" | "<" | "<=" | ">" | ">="
  left "+" | "-"
  left "*" | "/" | "%"
  prefix "-" | "!"
  atom
    | Postfix
    | Primary
};

rule Postfix = {
  @access base:Primary operations:Operation+
};

rule Operation = {
  | @member "." name:Name
  | @index "[" index:Expr "]"
};

rule Primary = {
  | @number value:$Number
  | @bool value:BoolLit
  | @call callee:Name "(" args:sepEnd(Expr, ",") ")"
  | @name value:Name
  | @group "(" value:Expr ")"
};

rule BoolLit = {
  | value:"true"
  | value:"false"
};

rule Name = {
  word
};

bind {
  builtin f32, i32, u32, bool, vec2f, vec3f, vec4f, vec2i, vec3i, vec4i, vec2u, vec3u, vec4u, vec2b, vec3b, vec4b, mat2x2f, mat2x3f, mat2x4f, mat3x2f, mat3x3f, mat3x4f, mat4x2f, mat4x3f, mat4x4f: type "type"
  builtin global_id, local_id, workgroup_id, local_index, num_workgroups: variable "value"
  def struct.name: struct "type"
  def field.name: property "field" in struct
  def resource.name: variable "value"
  def fn.name: function "function"
  def compute.name: function "entry point"
  def param.name: parameter "value" in fn.body
  def let.name, var.name: variable "value" after
  def for.name: variable "value" in for.body
  scope block
  ref typeName.name: type "type"
  ref name.value: value "name"
}
`;
