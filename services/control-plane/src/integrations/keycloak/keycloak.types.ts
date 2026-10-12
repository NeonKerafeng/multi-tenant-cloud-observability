/** Subsets of the Keycloak admin REST representations that we use. */

export type Attributes = Record<string, string[]>;

export interface KcGroup {
  id: string;
  name: string;
  path?: string;
  attributes?: Attributes;
  subGroups?: KcGroup[];
}

export interface KcUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  attributes?: Attributes | null;
  [key: string]: unknown;
}

export interface KcRole {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface KcClient {
  id: string;
  clientId: string;
  enabled?: boolean;
  /** Client attributes are plain strings (not arrays). */
  attributes?: Record<string, string>;
  [key: string]: unknown;
}

export interface KcClientScope {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface KcProtocolMapper {
  id?: string;
  name: string;
  protocol: string;
  protocolMapper: string;
  consentRequired?: boolean;
  config: Record<string, string>;
}

/** Ownership markers (CLAUDE.md §18.3.7). */
export const TENANT_MARKER = 'mtco_tenant_id';
export const USER_MARKER = 'mtco_user_id';
export const AGENT_MARKER = 'mtco_agent_id';

/** First value of a multi-valued attribute. */
export function attr(
  attributes: Attributes | null | undefined,
  key: string,
): string | undefined {
  const values = attributes?.[key];

  return Array.isArray(values) && values.length > 0 ? values[0] : undefined;
}
