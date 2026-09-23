export interface AuthUser {
  sub: string;
  username: string;
  roles: string[];
  groups: string[];
  vmAccountIds: string[];
}
