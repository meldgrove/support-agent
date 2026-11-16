import type { Role } from "@support-agent/shared/roles";

/** The signed-in person of a request. */
export type UserPrincipal = {
  kind: "user";
  id: string;
  email: string;
  name: string;
  role: Role;
  image: string | null;
};
