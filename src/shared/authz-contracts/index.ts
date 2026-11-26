import { z } from "zod";

const MembershipRoleSchema = z.enum(["member", "company_admin"]);
const WorkspaceRoleSchema = z.enum(["member", "workspace_admin"]);

export const TrustedActorInputSchema = z
  .object({
    personId: z.string().uuid(),
    platformAdmin: z.boolean(),
    companyMembership: z
      .object({
        companyId: z.string().uuid(),
        role: MembershipRoleSchema,
      })
      .strict()
      .optional(),
    workspaceMembership: z
      .object({
        companyId: z.string().uuid(),
        workspaceId: z.string().uuid(),
        role: WorkspaceRoleSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export type TrustedActorInput = z.input<typeof TrustedActorInputSchema>;

export interface ActorContext {
  readonly personId: string;
  readonly isPlatformAdmin: boolean;
  readonly companyMembership?: Readonly<{
    companyId: string;
    role: "member" | "company_admin";
  }>;
  readonly workspaceMembership?: Readonly<{
    companyId: string;
    workspaceId: string;
    role: "member" | "workspace_admin";
  }>;
}

export type AuthzAction =
  | "personal.chat"
  | "workspace.use"
  | "company.create"
  | "company.assign_admin"
  | "company.members.manage"
  | "workspace.create"
  | "workspace.manage"
  | "workspace.assign_admin"
  | "workspace.members.manage"
  | "usage.aggregate.read"
  | "rate_limit_events.read"
  | "security_events.read"
  | "provider_settings.manage"
  | "conversation.content.read";

export interface AuthorizationScope {
  companyId?: string;
  workspaceId?: string;
}

export function buildActorContext(input: TrustedActorInput): ActorContext {
  const parsed = TrustedActorInputSchema.parse(input);
  if (
    parsed.workspaceMembership &&
    parsed.companyMembership?.companyId !== parsed.workspaceMembership.companyId
  ) {
    throw new Error("Workspace membership must match its company membership");
  }
  return Object.freeze({
    personId: parsed.personId,
    isPlatformAdmin: parsed.platformAdmin,
    ...(parsed.companyMembership
      ? { companyMembership: Object.freeze(parsed.companyMembership) }
      : {}),
    ...(parsed.workspaceMembership
      ? { workspaceMembership: Object.freeze(parsed.workspaceMembership) }
      : {}),
  });
}

export function canPerform(
  actor: ActorContext,
  action: AuthzAction,
  scope: AuthorizationScope = {},
): boolean {
  if (action === "conversation.content.read") return false;
  if (action === "personal.chat") return true;
  if (action === "workspace.use") {
    return (
      scope.companyId !== undefined &&
      scope.workspaceId !== undefined &&
      actor.workspaceMembership?.companyId === scope.companyId &&
      actor.workspaceMembership.workspaceId === scope.workspaceId
    );
  }
  if (actor.isPlatformAdmin) return true;

  const companyMatch =
    scope.companyId !== undefined &&
    actor.companyMembership?.companyId === scope.companyId;
  const workspaceMatch =
    scope.workspaceId !== undefined &&
    actor.workspaceMembership?.workspaceId === scope.workspaceId &&
    actor.workspaceMembership.companyId === scope.companyId;
  const isCompanyAdmin =
    companyMatch && actor.companyMembership?.role === "company_admin";
  const isWorkspaceAdmin =
    workspaceMatch && actor.workspaceMembership?.role === "workspace_admin";
  switch (action) {
    case "company.members.manage":
      return isCompanyAdmin;
    case "workspace.create":
    case "workspace.assign_admin":
      return isCompanyAdmin;
    case "workspace.manage":
      return isCompanyAdmin || isWorkspaceAdmin;
    case "workspace.members.manage":
      return isCompanyAdmin || isWorkspaceAdmin;
    case "usage.aggregate.read":
      return isCompanyAdmin || isWorkspaceAdmin;
    case "company.create":
    case "company.assign_admin":
    case "rate_limit_events.read":
    case "security_events.read":
    case "provider_settings.manage":
      return false;
    default:
      return false;
  }
}
