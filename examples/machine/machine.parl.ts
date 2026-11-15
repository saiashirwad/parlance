// Generated from machine.parl by `parlance source`. Do not edit.
export default `grammar Machine

skip /\\s+/
skip /\\/\\/[^\\n]*/

word /[A-Za-z_][A-Za-z0-9_]*/
token String /"([^"\\\\\\n]|\\\\.)*"/

root File

rule File = {
  @machine "machine" name:Name "{" events:Event* states:StateDecl* "}"
};

rule Event = {
  | Import
  | @event "event" name:Name payload:Payload?
};

rule Import = {
  @import "import" specifier:$String ";"
};

rule Payload = {
  @payload "(" fields:sep(Field, ",") ")"
};

rule Field = {
  @field name:Name ":" type:Name
};

rule StateDecl = {
  | @initial "initial" "state" name:Name "{" transitions:Transition* "}"
  | @state "state" name:Name "{" transitions:Transition* "}"
  | @final "final" "state" name:Name "{" "}"
};

rule Transition = {
  @transition "on" event:Name binding:Binding? "->" target:Name
};

rule Binding = {
  @binding "(" fields:sep1(Name, ",") ")"
};

rule Name = { word };

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
`;
