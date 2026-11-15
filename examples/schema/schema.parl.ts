// Generated from schema.parl by `parlance source`. Do not edit.
export default `grammar Schema

skip /\\s+/
skip /\\/\\/[^\\n]*/

word /[A-Za-z_][A-Za-z0-9_]*/
token Number /\\d+/
token String /"([^"\\\\\\n]|\\\\.)*"/

root File

rule File = {
  @schema "schema" name:Name declarations:Decl*
};

rule Decl = {
  | Import
  | Enum
  | Model
  | Query
  | Insert
  | Update
  | Delete
};

rule Import = {
  @import "import" specifier:$String ";"
};

rule Enum = {
  @enum "enum" name:Name "{" members:Name* "}"
};

rule Model = {
  @model "model" name:Name "{" fields:Field* "}"
};

rule Field = {
  @field name:Name ":" type:TypeRef attributes:Attribute*
};

rule TypeRef = {
  | @list type:Base "[" "]"
  | @optional type:Base "?"
  | Base
};

rule Base = {
  @name name:Name
};

rule Attribute = {
  @attribute "@" name:Name args:AttributeArgs?
};

rule AttributeArgs = {
  "(" value:DefaultValue ")"
};

rule DefaultValue = {
  | @defaultName name:Name
  | @defaultLiteral value:Literal
};

rule Query = {
  @query "query" name:Name "(" params:sep(Param, ",") ")" ":" result:TypeRef "=" source:Name stages:Stage* ";"
};

rule Param = {
  @param name:Name ":" type:TypeRef
};

rule Insert = {
  @insert "insert" model:Name "{" assignments:sepEnd(InsertAssignment, ",") "}" ";"?
};

rule InsertAssignment = {
  @insertAssignment field:Name ":" value:MutationValue
};

rule Update = {
  @update "update" model:Name stages:UpdateStage* ";"?
};

rule UpdateStage = {
  | @updateWhere "|>" "where" field:Name "==" value:MutationValue
  | @updateSet "|>" "set" assignments:sep1(SetAssignment, ",")
};

rule SetAssignment = {
  @setAssignment field:Name "=" value:MutationValue
};

rule Delete = {
  @delete "delete" model:Name stages:DeleteStage* ";"?
};

rule DeleteStage = {
  @deleteWhere "|>" "where" field:Name "==" value:MutationValue
};

rule MutationValue = {
  | @bind "$" name:Name
  | @literal value:Literal
  | @name name:Name
};

rule Stage = {
  | @where "|>" "where" ~ field:Name "==" value:Value
  | @order "|>" "orderBy" ~ field:Name direction:Direction?
  | @limit "|>" "limit" ~ value:Value
  | @terminal "|>" terminal:Terminal
};

rule Value = {
  | @paramRef value:Name
  | @literal value:Literal
};

rule Literal = {
  | @number value:$Number
  | @string value:$String
};

rule Direction = {
  | @asc "asc"
  | @desc "desc"
};

rule Terminal = {
  | @first "first"
  | @all "all"
  | @count "count"
};

rule Name = { word };
`;
