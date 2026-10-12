import { ApiProperty } from '@nestjs/swagger';

import { listOf } from '../../common/http/list';

import type { AgentRecord, AgentStatus } from './agent.repository';

/** A host agent (collector). Its secret is shown once, at exchange. */
export class AgentView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'alpha-tenant' })
  tenantKey!: string;

  @ApiProperty({ example: 'otel-agent-6e012d7d-c990-4a18-8990-6dd62b22d63d' })
  clientId!: string;

  @ApiProperty({ enum: ['provisioning', 'active', 'disabled', 'revoked'] })
  status!: AgentStatus;

  @ApiProperty({ description: 'status === active' })
  enabled!: boolean;

  @ApiProperty()
  createdAt!: Date;
}

export const AgentList = listOf(AgentView);

export function toAgentView(agent: AgentRecord): AgentView {
  return {
    id: agent.id,
    tenantKey: agent.tenantKey,
    clientId: agent.clientId,
    status: agent.status,
    enabled: agent.status === 'active',
    createdAt: agent.createdAt,
  };
}
