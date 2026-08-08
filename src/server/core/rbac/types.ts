/** The resolved-permission view of a signed-in user, as exposed on tRPC context. */
export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  roleKeys: readonly string[];
  permissions: ReadonlySet<string>;
}
