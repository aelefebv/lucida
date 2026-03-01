export type PermissionScope = "client_view" | "scene_shared" | "admin";

export type CommandEnvelope<TArgs> = {
  message_type: "command";
  schema_version: "lucida-proto-0.1";
  session_id: string;
  client_id: string;
  client_seq: number;
  op: string;
  scope: PermissionScope;
  requires_lease: boolean;
  args: TArgs;
};

export type CreateCommandInput<TArgs> = {
  sessionId: string;
  clientId: string;
  clientSeq: number;
  op: string;
  scope: PermissionScope;
  requiresLease: boolean;
  args: TArgs;
};

export function createCommandEnvelope<TArgs>(
  input: CreateCommandInput<TArgs>,
): CommandEnvelope<TArgs> {
  if (input.clientSeq < 1 || !Number.isInteger(input.clientSeq)) {
    throw new Error("clientSeq must be a positive integer");
  }

  return {
    message_type: "command",
    schema_version: "lucida-proto-0.1",
    session_id: input.sessionId,
    client_id: input.clientId,
    client_seq: input.clientSeq,
    op: input.op,
    scope: input.scope,
    requires_lease: input.requiresLease,
    args: input.args,
  };
}
