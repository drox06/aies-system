import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      roleKeys: string[];
      permissions: string[];
      totpEnabled: boolean;
      mustChangePassword: boolean;
    } & DefaultSession["user"];
  }
}
